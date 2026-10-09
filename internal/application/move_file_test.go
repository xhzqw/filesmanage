package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"strings"
	"testing"
)

func countAudit(repo *memoryRepo, eventType string) int {
	repo.mu.Lock()
	defer repo.mu.Unlock()
	n := 0
	for _, e := range repo.audit {
		if e.EventType == eventType {
			n++
		}
	}
	return n
}

func totalAudit(repo *memoryRepo) int {
	repo.mu.Lock()
	defer repo.mu.Unlock()
	return len(repo.audit)
}

func TestMoveFileCommitsAcrossFolders(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "spec.txt", "text/plain", "", strings.NewReader("payload"))
	if err != nil {
		t.Fatalf("upload failed: %v", err)
	}
	target, err := s.CreateFolder(ctx, admin, "folder_root", "研发部")
	if err != nil {
		t.Fatalf("create target failed: %v", err)
	}
	result, err := s.MoveFile(ctx, admin, uploaded.FileID, target.ID, "folder_root", "key-move-1")
	if err != nil {
		t.Fatalf("move failed: %v", err)
	}
	if result.FileID != uploaded.FileID || result.FromFolderID != "folder_root" || result.ToFolderID != target.ID {
		t.Fatalf("unexpected move result %+v", result)
	}
	file, versions, err := s.FileMeta(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatal(err)
	}
	if file.FolderID != target.ID {
		t.Fatalf("file must live in the target folder, got %s", file.FolderID)
	}
	// Identity, version history and content hash stay untouched.
	if file.ID != uploaded.FileID || len(versions) != 1 || file.Sha256 != uploaded.Sha256 {
		t.Fatalf("move must preserve id, history and hash: %+v", file)
	}
	if countAudit(repo, "file.move") != 1 {
		t.Fatal("exactly one file.move audit event expected")
	}
}

func TestMoveFileRejectsStaleExpectedFolder(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "cas.txt", "text/plain", "", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	target, err := s.CreateFolder(ctx, admin, "folder_root", "研发部")
	if err != nil {
		t.Fatal(err)
	}
	before := totalAudit(repo)
	if _, err = s.MoveFile(ctx, admin, uploaded.FileID, target.ID, "folder_market", ""); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("stale expectedFolderId must conflict, got %v", err)
	}
	file, _, err := s.FileMeta(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatal(err)
	}
	if file.FolderID != "folder_root" || totalAudit(repo) != before {
		t.Fatal("CAS rejection must not move the file or write audit rows")
	}
}

func TestMoveFileNameConflictInTarget(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	if _, err := s.CommitUpload(ctx, admin, "folder_root", "dup.txt", "text/plain", "", strings.NewReader("a")); err != nil {
		t.Fatal(err)
	}
	source, err := s.CommitUpload(ctx, admin, "folder_market", "dup.txt", "text/plain", "", strings.NewReader("b"))
	if err != nil {
		t.Fatal(err)
	}
	before := totalAudit(repo)
	if _, err = s.MoveFile(ctx, admin, source.FileID, "folder_root", "", ""); !errors.Is(err, domain.ErrNameConflict) {
		t.Fatalf("duplicate name in target must conflict, got %v", err)
	}
	file, _, err := s.FileMeta(ctx, admin, source.FileID)
	if err != nil {
		t.Fatal(err)
	}
	if file.FolderID != "folder_market" || totalAudit(repo) != before {
		t.Fatal("name conflict must not move the file or write audit rows")
	}
}

func TestMoveFileForbiddenSourceAndTarget(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	user := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "acl.txt", "text/plain", "", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	repo.seedFolder(domain.Folder{ID: "folder_isolated", Name: "孤岛目录", OwnerID: "u_admin"})
	// The user may list and upload in the tree but holds no move action.
	repo.seedGrant(domain.ACL{ID: "acl_list_upload", FolderID: "folder_root", SubjectKind: "user", SubjectID: "u_user",
		Actions: []domain.Action{domain.ActionList, domain.ActionUpload}})
	before := totalAudit(repo)
	if _, err = s.MoveFile(ctx, user, uploaded.FileID, "folder_market", "", ""); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("missing move on source must be forbidden, got %v", err)
	}
	// With move on the source but no upload on the isolated target.
	repo.seedGrant(domain.ACL{ID: "acl_move", FolderID: "folder_root", SubjectKind: "user", SubjectID: "u_user",
		Actions: []domain.Action{domain.ActionList, domain.ActionMove}})
	if _, err = s.MoveFile(ctx, user, uploaded.FileID, "folder_isolated", "", ""); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("missing upload on target must be forbidden, got %v", err)
	}
	file, _, err := s.FileMeta(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatal(err)
	}
	if file.FolderID != "folder_root" || totalAudit(repo) != before {
		t.Fatal("forbidden moves must not change state or write audit rows")
	}
}

func TestMoveFileTargetMissingOrDeleted(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "gone.txt", "text/plain", "", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.MoveFile(ctx, admin, uploaded.FileID, "folder_missing", "", ""); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("missing target must be not found, got %v", err)
	}
	target, err := s.CreateFolder(ctx, admin, "folder_root", "临时目录")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.DeleteFolder(ctx, admin, target.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.MoveFile(ctx, admin, uploaded.FileID, target.ID, "", ""); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("deleted target must be not found, got %v", err)
	}
}

func TestMoveFileSameFolderConflict(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "stay.txt", "text/plain", "", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.MoveFile(ctx, admin, uploaded.FileID, "folder_root", "", ""); !errors.Is(err, domain.ErrMoveConflict) {
		t.Fatalf("moving onto the own folder must conflict, got %v", err)
	}
}

func TestMoveFileIdempotentReplay(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "replay.txt", "text/plain", "", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	target, err := s.CreateFolder(ctx, admin, "folder_root", "研发部")
	if err != nil {
		t.Fatal(err)
	}
	first, err := s.MoveFile(ctx, admin, uploaded.FileID, target.ID, "folder_root", "key-replay")
	if err != nil {
		t.Fatal(err)
	}
	// A replay with the same key returns the recorded result even though the
	// file no longer sits in the expected source folder.
	again, err := s.MoveFile(ctx, admin, uploaded.FileID, target.ID, "folder_root", "key-replay")
	if err != nil {
		t.Fatal(err)
	}
	if first != again {
		t.Fatalf("idempotent replay must return the same result: %+v vs %+v", first, again)
	}
	if countAudit(repo, "file.move") != 1 {
		t.Fatal("replay must not duplicate the audit event")
	}
	file, versions, err := s.FileMeta(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatal(err)
	}
	if file.FolderID != target.ID || len(versions) != 1 {
		t.Fatal("replay must not re-apply the move or touch history")
	}
}

func TestPreflightMoveReadyShape(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	first, err := s.CommitUpload(ctx, admin, "folder_root", "one.txt", "text/plain", "", strings.NewReader("a"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CommitUpload(ctx, admin, "folder_root", "two.txt", "text/plain", "", strings.NewReader("b"))
	if err != nil {
		t.Fatal(err)
	}
	before := totalAudit(repo)
	out, err := s.PreflightMove(ctx, admin, []MoveResource{
		{Kind: "file", ID: first.FileID}, {Kind: "file", ID: second.FileID},
	}, "folder_market", "all_or_nothing")
	if err != nil {
		t.Fatalf("preflight failed: %v", err)
	}
	if out.Status != "ready" || out.AllowedCount != 2 || len(out.Conflicts) != 0 {
		t.Fatalf("unexpected preflight result %+v", out)
	}
	// The read-only check must not move anything or write audit rows.
	for _, uploaded := range []UploadResult{first, second} {
		file, _, err := s.FileMeta(ctx, admin, uploaded.FileID)
		if err != nil {
			t.Fatal(err)
		}
		if file.FolderID != "folder_root" {
			t.Fatalf("preflight must not move %s, folder = %s", uploaded.FileID, file.FolderID)
		}
	}
	if totalAudit(repo) != before {
		t.Fatal("preflight must not write audit rows")
	}
	if out.CandidateRevision == "" || len(out.Warnings) == 0 {
		t.Fatalf("preflight must carry a revision and warnings: %+v", out)
	}
	if !strings.Contains(out.SourceSummary, "中晟生物科技") || !strings.Contains(out.TargetSummary, "市场部") {
		t.Fatalf("summaries must show the visible paths: %+v", out)
	}
	again, err := s.PreflightMove(ctx, admin, []MoveResource{{Kind: "file", ID: first.FileID}}, "folder_market", "")
	if err != nil {
		t.Fatal(err)
	}
	if again.CandidateRevision == out.CandidateRevision {
		t.Fatal("candidateRevision must be fresh per preflight")
	}
	if totalAudit(repo) != before {
		t.Fatal("preflight must not write audit rows")
	}
}

func TestPreflightMoveReportsConflicts(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	user := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()
	// Same live name in source and target folders.
	if _, err := s.CommitUpload(ctx, admin, "folder_root", "dup.txt", "text/plain", "", strings.NewReader("a")); err != nil {
		t.Fatal(err)
	}
	source, err := s.CommitUpload(ctx, admin, "folder_market", "dup.txt", "text/plain", "", strings.NewReader("b"))
	if err != nil {
		t.Fatal(err)
	}
	visible, err := s.CommitUpload(ctx, admin, "folder_root", "visible.txt", "text/plain", "", strings.NewReader("c"))
	if err != nil {
		t.Fatal(err)
	}
	repo.seedGrant(domain.ACL{ID: "acl_list_upload", FolderID: "folder_root", SubjectKind: "user", SubjectID: "u_user",
		Actions: []domain.Action{domain.ActionList, domain.ActionUpload}})
	cases := []struct {
		name       string
		caller     domain.User
		resources  []MoveResource
		wantStatus string
		wantCode   string
	}{
		{"name conflict", admin, []MoveResource{{Kind: "file", ID: source.FileID}}, "conflict", "E_NAME_CONFLICT"},
		{"missing file", admin, []MoveResource{{Kind: "file", ID: "file_missing"}}, "conflict", "E_NOT_FOUND"},
		{"unsupported kind", admin, []MoveResource{{Kind: "folder", ID: "folder_market"}}, "conflict", "E_BAD"},
		{"already there", admin, []MoveResource{{Kind: "file", ID: visible.FileID}}, "conflict", "E_MOVE_CONFLICT"},
		{"no move action", user, []MoveResource{{Kind: "file", ID: source.FileID}}, "forbidden", "E_FORBIDDEN"},
	}
	for _, tc := range cases {
		out, err := s.PreflightMove(ctx, tc.caller, tc.resources, "folder_root", "all_or_nothing")
		if err != nil {
			t.Fatalf("%s: preflight failed: %v", tc.name, err)
		}
		if out.Status != tc.wantStatus {
			t.Fatalf("%s: status = %s, want %s", tc.name, out.Status, tc.wantStatus)
		}
		if len(out.Conflicts) != 1 || out.Conflicts[0].Code != tc.wantCode || out.Conflicts[0].ID != tc.resources[0].ID {
			t.Fatalf("%s: unexpected conflicts %+v", tc.name, out.Conflicts)
		}
		if out.AllowedCount != 0 {
			t.Fatalf("%s: nothing may be allowed, got %d", tc.name, out.AllowedCount)
		}
	}
}

func TestPreflightHiddenSourceAndTargetStayIndistinguishable(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	user := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()
	hidden, err := s.CommitUpload(ctx, admin, "folder_root", "hidden.txt", "text/plain", "", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	// The caller may act inside the market subtree only; the root stays hidden.
	repo.seedGrant(domain.ACL{ID: "acl_market", FolderID: "folder_market", SubjectKind: "user", SubjectID: "u_user",
		Actions: []domain.Action{domain.ActionList, domain.ActionMove, domain.ActionUpload}})
	// A hidden target answers exactly like a missing one.
	if _, err = s.PreflightMove(ctx, user, []MoveResource{{Kind: "file", ID: hidden.FileID}}, "folder_root", ""); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("hidden target must answer not found, got %v", err)
	}
	// A hidden source is reported as a per-resource not-found conflict, never
	// with a name or a distinguishing code.
	out, err := s.PreflightMove(ctx, user, []MoveResource{{Kind: "file", ID: hidden.FileID}}, "folder_market", "")
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != "conflict" || len(out.Conflicts) != 1 || out.Conflicts[0].Code != "E_NOT_FOUND" {
		t.Fatalf("hidden source must be a not-found conflict: %+v", out)
	}
	if out.TargetSummary != "市场部" || out.SourceSummary != "" {
		t.Fatalf("summaries must not leak the hidden root name: %+v", out)
	}
}

func TestPreflightSummaryTruncatesAtHiddenAncestor(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	user := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()
	marketParent := "folder_market"
	repo.seedFolder(domain.Folder{ID: "folder_rd_a", Name: "研发甲", ParentID: &marketParent, OwnerID: "u_admin"})
	repo.seedFolder(domain.Folder{ID: "folder_rd_b", Name: "研发乙", ParentID: &marketParent, OwnerID: "u_admin"})
	file, err := s.CommitUpload(ctx, admin, "folder_rd_a", "deep.txt", "text/plain", "", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	// Grants only on the two leaf folders: the market ancestor stays hidden.
	for _, id := range []string{"folder_rd_a", "folder_rd_b"} {
		repo.seedGrant(domain.ACL{ID: "acl_" + id, FolderID: id, SubjectKind: "user", SubjectID: "u_user",
			Actions: []domain.Action{domain.ActionList, domain.ActionMove, domain.ActionUpload}})
	}
	out, err := s.PreflightMove(ctx, user, []MoveResource{{Kind: "file", ID: file.FileID}}, "folder_rd_b", "all_or_nothing")
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != "ready" || out.AllowedCount != 1 {
		t.Fatalf("leaf-granted move must be ready: %+v", out)
	}
	if out.SourceSummary != "研发甲" || out.TargetSummary != "研发乙" {
		t.Fatalf("summaries must truncate at the hidden ancestor: %+v", out)
	}
}

func TestPreflightRejectsBadInput(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	if _, err := s.PreflightMove(ctx, admin, nil, "folder_market", ""); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("empty resources must be rejected, got %v", err)
	}
	if _, err := s.PreflightMove(ctx, admin, []MoveResource{{Kind: "file", ID: "file_x"}}, "", ""); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("empty target must be rejected, got %v", err)
	}
	if _, err := s.PreflightMove(ctx, admin, []MoveResource{{Kind: "file", ID: "file_x"}}, "folder_market", "best_effort"); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("unknown mode must be rejected, got %v", err)
	}
}
