package application

import (
	"context"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"testing"
	"time"
)

func projectAdminAndMember(t *testing.T) (*Service, domain.User, domain.User) {
	t.Helper()
	s, repo := testService(t)
	admin := repo.users["u_admin"].user
	member := repo.users["u_user"].user
	return s, admin, member
}

func mustProject(t *testing.T, s *Service, actor domain.User, name string) ports.Project {
	t.Helper()
	p, err := s.ProjectCreate(context.Background(), actor, ProjectWriteInput{
		Name: name, Icon: "◇", Status: "progress", Priority: "high", Team: "工程部",
		OwnerID: "u_user",
	})
	if err != nil {
		t.Fatalf("create %q: %v", name, err)
	}
	return p
}

func TestProjectValidationRejectsInvalidFields(t *testing.T) {
	if !projectIcons["◇"] || !projectStatuses["done"] || !projectPriorities["low"] || !projectTeams["文件管理"] || !projectDocKinds["pdf"] {
		t.Fatal("enum vocabularies must match the frontend contract")
	}
	base := func() ports.Project {
		return ports.Project{Name: "研发计划", Icon: "◇", Status: "notstarted", Priority: "mid", Team: "", Progress: 0}
	}
	bad := map[string]func(*ports.Project){
		"blank name":       func(p *ports.Project) { p.Name = "   " },
		"oversize name":    func(p *ports.Project) { p.Name = string(make([]rune, 121)) },
		"unknown icon":     func(p *ports.Project) { p.Icon = "★" },
		"unknown status":   func(p *ports.Project) { p.Status = "archived" },
		"unknown priority": func(p *ports.Project) { p.Priority = "urgent" },
		"unknown team":     func(p *ports.Project) { p.Team = "财务部" },
		"progress over":    func(p *ports.Project) { p.Progress = 101 },
		"progress below":   func(p *ports.Project) { p.Progress = -1 },
		"end before start": func(p *ports.Project) {
			p.StartDate, p.EndDate = new(mustDate(t, "2026-03-10")), new(mustDate(t, "2026-03-09"))
		},
	}
	for name, mutate := range bad {
		t.Run(name, func(t *testing.T) {
			p := base()
			mutate(&p)
			if validateProject(&p) {
				t.Fatalf("accepted invalid project: %s", name)
			}
		})
	}
	good := base()
	good.Name = "  受控文件 V2 迁移  "
	good.Description = "  背景  "
	if !validateProject(&good) || good.Name != "受控文件 V2 迁移" || good.Description != "背景" {
		t.Fatalf("valid project rejected or not normalized: %+v", good)
	}
}

func mustDate(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, ok := parseProjectDate(value)
	if !ok || parsed == nil {
		t.Fatalf("unexpected date rejection: %s", value)
	}
	return *parsed
}

func TestProjectCreateRejectsImpossibleCalendarDates(t *testing.T) {
	s, admin, _ := projectAdminAndMember(t)
	for _, bad := range []string{"2026-02-31", "2026-13-01", "2026-03-10T00:00:00Z", "2026/03/10", "tomorrow"} {
		if _, err := s.ProjectCreate(context.Background(), admin, ProjectWriteInput{Name: "日期项目", StartDate: new(bad)}); !errors.Is(err, domain.ErrInvalidInput) {
			t.Fatalf("accepted start date %q", bad)
		}
	}
	created := mustProject(t, s, admin, "日期基线")
	if _, err := s.ProjectUpdate(context.Background(), admin, created.ID, ProjectPatch{EndDate: new("2026-02-31")}); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatal("PATCH accepted an impossible end date")
	}
}

func TestProjectDateParsingAcceptsEmptyAndDateOnly(t *testing.T) {
	if got, ok := parseProjectDate(""); !ok || got != nil {
		t.Fatalf("empty date must mean unset: %v %v", got, ok)
	}
	if _, ok := parseProjectDate("2026-03-10T00:00:00Z"); ok {
		t.Fatal("timestamp must not be accepted as a date")
	}
	if _, ok := parseProjectDate("2026/03/10"); ok {
		t.Fatal("slashed date must not be accepted")
	}
}

func TestProjectWritesRequireAdminButReadsAreOpen(t *testing.T) {
	s, admin, member := projectAdminAndMember(t)
	ctx := context.Background()
	created := mustProject(t, s, admin, "管理员创建")

	if _, err := s.ProjectCreate(ctx, member, ProjectWriteInput{Name: "成员创建"}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("member create must be forbidden: %v", err)
	}
	if _, err := s.ProjectUpdate(ctx, member, created.ID, ProjectPatch{Name: new("偷偷改名")}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("member update must be forbidden: %v", err)
	}
	if err := s.ProjectDelete(ctx, member, created.ID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("member delete must be forbidden: %v", err)
	}
	if _, err := s.ProjectAddComment(ctx, member, created.ID, "无权限"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("member comment must be forbidden: %v", err)
	}
	if _, err := s.ProjectAddDocs(ctx, member, created.ID, []ports.ProjectDoc{{DocID: "file_1", Name: "a.pdf", Kind: "pdf"}}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("member doc link must be forbidden: %v", err)
	}
	if _, err := s.ProjectGet(ctx, member, created.ID); err != nil {
		t.Fatalf("member read must be allowed: %v", err)
	}
	page, err := s.ProjectList(ctx, member)
	if err != nil || len(page.Items) != 1 || page.AsOf == "" {
		t.Fatalf("member list must be allowed with asOf: %+v %v", page, err)
	}
}

func TestProjectCreateValidatesOwnerAndTrimsInput(t *testing.T) {
	s, admin, _ := projectAdminAndMember(t)
	ctx := context.Background()
	if _, err := s.ProjectCreate(ctx, admin, ProjectWriteInput{Name: "x", OwnerID: "u_ghost"}); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("unknown owner must be rejected: %v", err)
	}
	p, err := s.ProjectCreate(ctx, admin, ProjectWriteInput{
		Name: "  项目甲  ", Description: "  背景  ", OwnerID: " u_user ",
		StartDate: new("2026-01-02"), EndDate: new("2026-02-03"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if p.Name != "项目甲" || p.Description != "背景" || p.OwnerID != "u_user" || p.OwnerName != "普通用户" {
		t.Fatalf("create did not normalize/join: %+v", p)
	}
	if p.StartDate == nil || p.StartDate.Format("2006-01-02") != "2026-01-02" || p.CreatedBy != admin.ID {
		t.Fatalf("dates or creator lost: %+v", p)
	}
	if p.Icon != "◇" || p.Status != "notstarted" || p.Priority != "mid" {
		t.Fatalf("defaults not applied: %+v", p)
	}
	if p.Comments == nil || p.Todos == nil || p.Docs == nil {
		t.Fatal("sub-resource lists must never be null")
	}
}

func TestProjectPatchShallowMergesAndKeepsOtherFields(t *testing.T) {
	s, admin, _ := projectAdminAndMember(t)
	ctx := context.Background()
	created := mustProject(t, s, admin, "基线项目")

	// Board drag: status only, progress untouched unless the caller sets it.
	updated, err := s.ProjectUpdate(ctx, admin, created.ID, ProjectPatch{Status: new("done"), Progress: new(100)})
	if err != nil || updated.Status != "done" || updated.Progress != 100 {
		t.Fatalf("status patch failed: %+v %v", updated, err)
	}
	if updated.Name != "基线项目" || updated.Priority != "high" || updated.Team != "工程部" || updated.OwnerID != "u_user" {
		t.Fatalf("patch cleared unrelated fields: %+v", updated)
	}
	// Gantt drag: both dates at once.
	same, err := s.ProjectUpdate(ctx, admin, created.ID, ProjectPatch{
		StartDate: new("2026-05-01"), EndDate: new("2026-05-11"),
	})
	if err != nil || same.StartDate == nil || same.EndDate == nil ||
		same.StartDate.Format("2006-01-02") != "2026-05-01" || same.EndDate.Format("2006-01-02") != "2026-05-11" {
		t.Fatalf("date patch failed: %+v %v", same, err)
	}
	// Clearing dates uses the explicit empty string.
	cleared, err := s.ProjectUpdate(ctx, admin, created.ID, ProjectPatch{StartDate: new(""), EndDate: new("")})
	if err != nil || cleared.StartDate != nil || cleared.EndDate != nil {
		t.Fatalf("empty date did not clear: %+v %v", cleared, err)
	}
	// A single date that now precedes the stored end must be rejected.
	if _, err = s.ProjectUpdate(ctx, admin, created.ID, ProjectPatch{EndDate: new("2026-05-10")}); err != nil {
		t.Fatalf("single date patch failed: %v", err)
	}
	if _, err = s.ProjectUpdate(ctx, admin, created.ID, ProjectPatch{StartDate: new("2026-06-01")}); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("end before start must be rejected: %v", err)
	}
	if _, err = s.ProjectUpdate(ctx, admin, created.ID, ProjectPatch{Favorite: new(true)}); err != nil {
		t.Fatalf("favorite patch failed: %v", err)
	}
	favorite, _ := s.ProjectGet(ctx, admin, created.ID)
	if !favorite.Favorite || favorite.EndDate == nil {
		t.Fatalf("favorite patch lost state: %+v", favorite)
	}
	if _, err = s.ProjectUpdate(ctx, admin, created.ID, ProjectPatch{OwnerID: new("u_ghost")}); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("patch to unknown owner must be rejected: %v", err)
	}
}

func TestProjectDeleteArchivesInsteadOfRemoving(t *testing.T) {
	s, admin, _ := projectAdminAndMember(t)
	ctx := context.Background()
	created := mustProject(t, s, admin, "待删除项目")
	if _, err := s.ProjectAddComment(ctx, admin, created.ID, "保留的评论"); err != nil {
		t.Fatal(err)
	}
	if err := s.ProjectDelete(ctx, admin, created.ID); err != nil {
		t.Fatal(err)
	}
	page, err := s.ProjectList(ctx, admin)
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("archived project must leave the list: %+v %v", page.Items, err)
	}
	detail, err := s.ProjectGet(ctx, admin, created.ID)
	if err != nil || !detail.Archived || len(detail.Comments) != 1 {
		t.Fatalf("archived project must keep its history: %+v %v", detail, err)
	}
	if _, err = s.ProjectGet(ctx, admin, 999999); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("missing project must be E_NOT_FOUND: %v", err)
	}
}

func TestProjectSubResourcesValidateAndPersist(t *testing.T) {
	s, admin, _ := projectAdminAndMember(t)
	ctx := context.Background()
	p := mustProject(t, s, admin, "子资源项目")

	if _, err := s.ProjectAddComment(ctx, admin, p.ID, "   "); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatal("blank comment must be rejected")
	}
	comment, err := s.ProjectAddComment(ctx, admin, p.ID, "  第一条评论  ")
	if err != nil || comment.Body != "第一条评论" || comment.Author != admin.DisplayName || comment.AuthorID != admin.ID {
		t.Fatalf("comment not stored with author: %+v %v", comment, err)
	}
	if _, err = s.ProjectAddComment(ctx, admin, 999999, "no project"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("comment on missing project must be E_NOT_FOUND: %v", err)
	}

	todo, err := s.ProjectAddTodo(ctx, admin, p.ID, "验收文档")
	if err != nil || todo.Done {
		t.Fatalf("todo not created open: %+v %v", todo, err)
	}
	if err = s.ProjectSetTodoDone(ctx, admin, p.ID, todo.ID, true); err != nil {
		t.Fatal(err)
	}
	if err = s.ProjectSetTodoDone(ctx, admin, p.ID, 424242, true); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("unknown todo must be E_NOT_FOUND: %v", err)
	}
	detail, _ := s.ProjectGet(ctx, admin, p.ID)
	if len(detail.Todos) != 1 || !detail.Todos[0].Done || len(detail.Comments) != 1 {
		t.Fatalf("sub-resources not persisted: %+v", detail)
	}
	if err = s.ProjectDeleteTodo(ctx, admin, p.ID, todo.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.ProjectDeleteTodo(ctx, admin, p.ID, todo.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("second delete must be E_NOT_FOUND: %v", err)
	}
}

func TestProjectDocsBatchIsIdempotentAndAllOrNothing(t *testing.T) {
	s, admin, _ := projectAdminAndMember(t)
	ctx := context.Background()
	p := mustProject(t, s, admin, "文档项目")

	if _, err := s.ProjectAddDocs(ctx, admin, p.ID, nil); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatal("empty batch must be rejected")
	}
	if _, err := s.ProjectAddDocs(ctx, admin, p.ID, []ports.ProjectDoc{
		{DocID: "file_1", Name: "a.pdf", Kind: "pdf"},
		{DocID: "file_2", Name: "b.exe", Kind: "exe"},
	}); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatal("a batch with one invalid item must be rejected before any write")
	}
	detail, _ := s.ProjectGet(ctx, admin, p.ID)
	if len(detail.Docs) != 0 {
		t.Fatalf("rejected batch wrote rows: %+v", detail.Docs)
	}

	added, err := s.ProjectAddDocs(ctx, admin, p.ID, []ports.ProjectDoc{
		{DocID: "file_1", Name: "a.pdf", Kind: "pdf"},
		{DocID: "file_2", Name: "b.fig", Kind: "figma"},
		{DocID: "file_2", Name: "b.fig", Kind: "figma"},
	})
	if err != nil || added != 2 {
		t.Fatalf("duplicate ids in one batch must collapse: added=%d err=%v", added, err)
	}
	again, err := s.ProjectAddDocs(ctx, admin, p.ID, []ports.ProjectDoc{{DocID: "file_1", Name: "a.pdf", Kind: "pdf"}})
	if err != nil || again != 0 {
		t.Fatalf("re-link must be idempotent, not a conflict: added=%d err=%v", again, err)
	}
	if err = s.ProjectRemoveDoc(ctx, admin, p.ID, "file_1"); err != nil {
		t.Fatal(err)
	}
	if err = s.ProjectRemoveDoc(ctx, admin, p.ID, "file_1"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("second unlink must be E_NOT_FOUND: %v", err)
	}
}

func TestProjectViewStateIsPerUserAndWholeObject(t *testing.T) {
	s, admin, member := projectAdminAndMember(t)
	ctx := context.Background()
	if raw, err := s.ProjectViewState(ctx, admin); err != nil || raw != nil {
		t.Fatalf("unsaved view must read as null without error: %q %v", raw, err)
	}
	first := json.RawMessage(`{"colVis":{"status":true},"sort":{"field":"name","dir":1},"filters":{"status":{"notstarted":true}},"scope":"all","view":"board"}`)
	if err := s.ProjectPutViewState(ctx, admin, first); err != nil {
		t.Fatal(err)
	}
	stored, err := s.ProjectViewState(ctx, admin)
	if err != nil || string(stored) != string(first) {
		t.Fatalf("view round trip failed: %s %v", stored, err)
	}
	// The last whole-object write wins.
	second := json.RawMessage(`{"view":"gantt","scope":"mine"}`)
	if err = s.ProjectPutViewState(ctx, admin, second); err != nil {
		t.Fatal(err)
	}
	stored, _ = s.ProjectViewState(ctx, admin)
	if string(stored) != string(second) {
		t.Fatalf("overwrite must replace the whole object: %s", stored)
	}
	// Another user must never see it.
	if raw, err := s.ProjectViewState(ctx, member); err != nil || raw != nil {
		t.Fatalf("view state leaked across users: %q %v", raw, err)
	}
	for _, bad := range []string{"", "[]", "null", "not-json", `"text"`} {
		if err := s.ProjectPutViewState(ctx, admin, json.RawMessage(bad)); !errors.Is(err, domain.ErrInvalidInput) {
			t.Fatalf("accepted non-object view %q", bad)
		}
	}
}
