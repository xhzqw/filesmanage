package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"regexp"
	"testing"
	"time"

	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Opt-in: a fresh disposable database is mandatory because this test creates
// users, folders and projects that must never touch the dev database. Run it
// from scripts/project_fresh_pg_lab.sh only.
var projectScratchPattern = regexp.MustCompile(`^project_iso_20261022_[a-f0-9]{16}$`)

func TestProjectPostgresRoundTrip(t *testing.T) {
	dsn := os.Getenv("PROJECT_TEST_DSN")
	if dsn == "" {
		t.Skip("set PROJECT_TEST_DSN for an isolated PostgreSQL 17 database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var dbName string
	if err = pool.QueryRow(ctx, "SELECT current_database()").Scan(&dbName); err != nil {
		t.Fatal(err)
	}
	if !projectScratchPattern.MatchString(dbName) {
		t.Fatalf("refusing to run against %q: expected a project_iso_* scratch database", dbName)
	}

	repo := New(pool)
	service := application.New(repo, nil).WithClock(func() time.Time {
		return time.Date(2026, 10, 22, 3, 44, 0, 0, time.UTC)
	})

	seed := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("fixture %q: %v", sql, err)
		}
	}
	seed(`INSERT INTO users(id,login,display_name,password_hash,is_admin) VALUES
	 ('project_admin','project_admin','系统管理员','fixture',true),
	 ('project_member','project_member','普通用户','fixture',false)`)
	admin := domain.User{ID: "project_admin", DisplayName: "系统管理员", IsAdmin: true}
	member := domain.User{ID: "project_member", DisplayName: "普通用户"}

	// Create + defaults + owner join.
	created, err := service.ProjectCreate(ctx, admin, application.ProjectWriteInput{
		Name: "  受控文件 V2 迁移  ", Icon: "◈", Description: "背景", Status: "progress", Priority: "high",
		Team: "工程部", OwnerID: "project_member", Progress: new(30),
		StartDate: new("2026-01-02"), EndDate: new("2026-03-04"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.ID < 1 || created.Name != "受控文件 V2 迁移" || created.OwnerName != "普通用户" ||
		created.StartDate == nil || created.StartDate.UTC().Format("2006-01-02") != "2026-01-02" {
		t.Fatalf("create round trip lost data: %+v", created)
	}
	if created.Comments == nil || created.Todos == nil || created.Docs == nil {
		t.Fatalf("sub-resource slices must be empty, not null: %+v", created)
	}

	// Invalid data must be refused before it reaches the database.
	if _, err = service.ProjectCreate(ctx, admin, application.ProjectWriteInput{Name: "  "}); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("blank name accepted: %v", err)
	}
	if _, err = service.ProjectCreate(ctx, admin, application.ProjectWriteInput{Name: "幽灵负责人", OwnerID: "no_such_user"}); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("unknown owner accepted: %v", err)
	}
	// The CHECK constraint backs up validation: a direct write of end<start fails.
	if _, err = pool.Exec(ctx, `INSERT INTO projects(name,start_date,end_date,created_by)
	 VALUES('反序日期','2026-05-10','2026-05-01','project_admin')`); err == nil {
		t.Fatal("end_date before start_date must be rejected by the schema")
	}
	// The enum CHECKs must reject a free-form status/team.
	if _, err = pool.Exec(ctx, `INSERT INTO projects(name,status,created_by) VALUES('坏状态','archived','project_admin')`); err == nil {
		t.Fatal("unknown status must be rejected by the schema")
	}
	// Member writes are forbidden at the service boundary.
	if _, err = service.ProjectCreate(ctx, member, application.ProjectWriteInput{Name: "成员创建"}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("member create not forbidden: %v", err)
	}

	// Partial update keeps unrelated columns, and archives leave the list.
	updated, err := service.ProjectUpdate(ctx, admin, created.ID, application.ProjectPatch{
		Status: new("done"), Progress: new(100),
	})
	if err != nil || updated.Status != "done" || updated.Progress != 100 || updated.Name != created.Name || updated.Team != "工程部" {
		t.Fatalf("patch did not shallow-merge: %+v %v", updated, err)
	}
	if _, err = service.ProjectUpdate(ctx, admin, created.ID, application.ProjectPatch{StartDate: new("2026-06-01")}); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("start after stored end accepted: %v", err)
	}

	comment, err := service.ProjectAddComment(ctx, admin, created.ID, "  第一条评论  ")
	if err != nil || comment.Author != "系统管理员" || comment.Body != "第一条评论" {
		t.Fatalf("comment round trip failed: %+v %v", comment, err)
	}
	todo, err := service.ProjectAddTodo(ctx, admin, created.ID, "验收文档")
	if err != nil {
		t.Fatal(err)
	}
	if err = service.ProjectSetTodoDone(ctx, admin, created.ID, todo.ID, true); err != nil {
		t.Fatal(err)
	}

	// Document links: batch is idempotent and uses the live file name when the
	// file still exists, the stored name when it does not.
	seed(`INSERT INTO folders(id,name,owner_id) VALUES('project_folder','项目资料','project_admin')`)
	seed(`INSERT INTO files(id,folder_id,name,uploaded_by) VALUES('project_file','project_folder','正式名.pdf','project_admin')`)
	added, err := service.ProjectAddDocs(ctx, admin, created.ID, []ports.ProjectDoc{
		{DocID: "project_file", Name: "旧名.pdf", Kind: "pdf"},
		{DocID: "project_missing", Name: "手册.docx", Kind: "file"},
	})
	if err != nil || added != 2 {
		t.Fatalf("batch link failed: added=%d err=%v", added, err)
	}
	if again, err := service.ProjectAddDocs(ctx, admin, created.ID, []ports.ProjectDoc{{DocID: "project_file", Name: "旧名.pdf", Kind: "pdf"}}); err != nil || again != 0 {
		t.Fatalf("re-link must be idempotent: added=%d err=%v", again, err)
	}
	detail, err := service.ProjectGet(ctx, admin, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Docs) != 2 {
		t.Fatalf("expected 2 links, got %+v", detail.Docs)
	}
	names := map[string]string{}
	for _, d := range detail.Docs {
		names[d.DocID] = d.Name
	}
	if names["project_file"] != "正式名.pdf" {
		t.Fatalf("live file name must win: %+v", names)
	}
	if names["project_missing"] != "手册.docx" {
		t.Fatalf("stored name must be the fallback: %+v", names)
	}
	// A rejected batch writes nothing.
	if _, err = service.ProjectAddDocs(ctx, admin, created.ID, []ports.ProjectDoc{
		{DocID: "batch_ok", Name: "ok.pdf", Kind: "pdf"},
		{DocID: "batch_bad", Name: "bad.exe", Kind: "exe"},
	}); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("invalid batch accepted: %v", err)
	}
	detail, _ = service.ProjectGet(ctx, admin, created.ID)
	if len(detail.Docs) != 2 {
		t.Fatalf("rejected batch leaked rows: %+v", detail.Docs)
	}

	// Whole-object view state, isolated per user.
	if raw, err := service.ProjectViewState(ctx, admin); err != nil || raw != nil {
		t.Fatalf("unsaved view must be nil: %q %v", raw, err)
	}
	view := []byte(`{"colVis":{"status":true},"scope":"mine","view":"gantt","columnConfig":{"ganttScale":1}}`)
	if err = service.ProjectPutViewState(ctx, admin, view); err != nil {
		t.Fatal(err)
	}
	stored, err := service.ProjectViewState(ctx, admin)
	// jsonb normalizes key order and whitespace, so equality is semantic.
	if err != nil || !sameJSON(stored, view) {
		t.Fatalf("view round trip: %s %v", stored, err)
	}
	if raw, err := service.ProjectViewState(ctx, member); err != nil || raw != nil {
		t.Fatalf("view leaked to another user: %q %v", raw, err)
	}
	if err = service.ProjectPutViewState(ctx, admin, []byte(`null`)); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("null view accepted: %v", err)
	}

	// Delete archives; the list hides it; the row and its children survive.
	if err = service.ProjectDelete(ctx, admin, created.ID); err != nil {
		t.Fatal(err)
	}
	page, err := service.ProjectList(ctx, member)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range page.Items {
		if p.ID == created.ID {
			t.Fatalf("archived project still listed: %+v", p)
		}
	}
	if page.AsOf == "" {
		t.Fatal("asOf must be set")
	}
	archived, err := service.ProjectGet(ctx, admin, created.ID)
	if err != nil || !archived.Archived || len(archived.Comments) != 1 || len(archived.Todos) != 1 {
		t.Fatalf("archive lost history: %+v %v", archived, err)
	}

	// Soft delete is idempotent and unknown ids are E_NOT_FOUND.
	if err = service.ProjectDelete(ctx, admin, created.ID); err != nil {
		t.Fatalf("second delete failed: %v", err)
	}
	if err = service.ProjectDelete(ctx, admin, 999999); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("unknown project delete: %v", err)
	}
	if _, err = service.ProjectGet(ctx, admin, 999999); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("unknown project read: %v", err)
	}

	// Every write left an audit trail.
	var audits int
	if err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_events WHERE target_kind='project' AND actor_id='project_admin'`).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if audits < 4 {
		t.Fatalf("expected create/update/comment/docs audit rows, got %d", audits)
	}
}

// sameJSON compares two documents after decoding: PostgreSQL re-serializes
// jsonb with sorted keys and normalized spacing.
func sameJSON(left, right []byte) bool {
	var a, b any
	if json.Unmarshal(left, &a) != nil || json.Unmarshal(right, &b) != nil {
		return false
	}
	return reflect.DeepEqual(a, b)
}
