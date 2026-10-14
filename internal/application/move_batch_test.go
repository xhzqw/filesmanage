package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestMoveFilesBatchCommitsAcrossFolders(t *testing.T) {
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
	third, err := s.CommitUpload(ctx, admin, "folder_market", "three.txt", "text/plain", "", strings.NewReader("c"))
	if err != nil {
		t.Fatal(err)
	}
	target, err := s.CreateFolder(ctx, admin, "folder_root", "批量目标")
	if err != nil {
		t.Fatal(err)
	}
	before := totalAudit(repo)
	result, err := s.MoveFilesBatch(ctx, admin, []string{first.FileID, third.FileID, second.FileID}, target.ID, "all_or_nothing", "key-batch-1")
	if err != nil {
		t.Fatalf("batch move failed: %v", err)
	}
	if result.Status != "committed" || result.Count != 3 || len(result.Conflicts) != 0 || len(result.Moved) != 3 {
		t.Fatalf("unexpected batch result %+v", result)
	}
	want := []MoveResult{
		{FileID: first.FileID, FromFolderID: "folder_root", ToFolderID: target.ID},
		{FileID: third.FileID, FromFolderID: "folder_market", ToFolderID: target.ID},
		{FileID: second.FileID, FromFolderID: "folder_root", ToFolderID: target.ID},
	}
	for i, moved := range result.Moved {
		if moved != want[i] {
			t.Fatalf("moved[%d] = %+v, want %+v", i, moved, want[i])
		}
	}
	// Identity, version history and content hash survive a batch move.
	for _, uploaded := range []UploadResult{first, second, third} {
		file, versions, err := s.FileMeta(ctx, admin, uploaded.FileID)
		if err != nil {
			t.Fatal(err)
		}
		if file.FolderID != target.ID || file.ID != uploaded.FileID || len(versions) != 1 || file.Sha256 != uploaded.Sha256 {
			t.Fatalf("batch move must preserve id, folder, history and hash: %+v", file)
		}
	}
	if countAudit(repo, "file.move") != 3 || totalAudit(repo) != before+3 {
		t.Fatalf("one file.move audit row per file expected, got %d", countAudit(repo, "file.move"))
	}
}

func TestMoveFilesBatchAllOrNothingOnNameConflict(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	target, err := s.CreateFolder(ctx, admin, "folder_root", "批量目标")
	if err != nil {
		t.Fatal(err)
	}
	// The live name conflict already sits in the target.
	if _, err := s.CommitUpload(ctx, admin, target.ID, "dup.txt", "text/plain", "", strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	conflicting, err := s.CommitUpload(ctx, admin, "folder_market", "dup.txt", "text/plain", "", strings.NewReader("y"))
	if err != nil {
		t.Fatal(err)
	}
	clean, err := s.CommitUpload(ctx, admin, "folder_market", "clean.txt", "text/plain", "", strings.NewReader("z"))
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.CommitUpload(ctx, admin, "folder_root", "other.txt", "text/plain", "", strings.NewReader("w"))
	if err != nil {
		t.Fatal(err)
	}
	before := totalAudit(repo)
	fileIDs := []string{conflicting.FileID, clean.FileID, other.FileID}
	result, err := s.MoveFilesBatch(ctx, admin, fileIDs, target.ID, "all_or_nothing", "key-batch-conflict")
	if err != nil {
		t.Fatalf("batch conflict must answer a result, not an error: %v", err)
	}
	if result.Status != "conflict" || result.Count != 1 || len(result.Moved) != 0 || len(result.Conflicts) != 1 {
		t.Fatalf("unexpected batch conflict result %+v", result)
	}
	if result.Conflicts[0].ID != conflicting.FileID || result.Conflicts[0].Code != "E_NAME_CONFLICT" {
		t.Fatalf("unexpected conflict entry %+v", result.Conflicts[0])
	}
	// All-or-nothing: every file keeps its original folder and nothing is audited.
	for _, uploaded := range []UploadResult{conflicting, clean, other} {
		file, _, err := s.FileMeta(ctx, admin, uploaded.FileID)
		if err != nil {
			t.Fatal(err)
		}
		if file.FolderID == target.ID {
			t.Fatalf("conflict must not move %s into the target", uploaded.FileID)
		}
	}
	if totalAudit(repo) != before {
		t.Fatal("conflict must not write audit rows")
	}
	// Replaying the same key re-validates to the same conflict list without
	// writing anything (conflict outcomes are not persisted).
	again, err := s.MoveFilesBatch(ctx, admin, fileIDs, target.ID, "all_or_nothing", "key-batch-conflict")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(result, again) {
		t.Fatalf("conflict replay must return the same result: %+v vs %+v", result, again)
	}
	if totalAudit(repo) != before {
		t.Fatal("conflict replay must not write audit rows")
	}
}

func TestMoveFilesBatchPermissionBlocksWholeBatch(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	user := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()
	forbidden, err := s.CommitUpload(ctx, admin, "folder_root", "acl.txt", "text/plain", "", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	allowed, err := s.CommitUpload(ctx, admin, "folder_market", "ok.txt", "text/plain", "", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	target, err := s.CreateFolder(ctx, admin, "folder_market", "批量目标")
	if err != nil {
		t.Fatal(err)
	}
	// The user may act inside the market subtree (target included) but holds no
	// grant on the root where acl.txt lives.
	repo.seedGrant(domain.ACL{ID: "acl_market", FolderID: "folder_market", SubjectKind: "user", SubjectID: "u_user",
		Actions: []domain.Action{domain.ActionList, domain.ActionMove, domain.ActionUpload}})
	before := totalAudit(repo)
	result, err := s.MoveFilesBatch(ctx, user, []string{forbidden.FileID, allowed.FileID}, target.ID, "all_or_nothing", "")
	if err != nil {
		t.Fatalf("permission conflict must answer a result, not an error: %v", err)
	}
	if result.Status != "conflict" || len(result.Conflicts) != 1 || result.Conflicts[0].ID != forbidden.FileID || result.Conflicts[0].Code != "E_FORBIDDEN" {
		t.Fatalf("unexpected permission conflict result %+v", result)
	}
	// A target without upload permission conflicts the same way.
	repo.seedFolder(domain.Folder{ID: "folder_secret", Name: "保密目录", OwnerID: "u_admin"})
	blocked, err := s.MoveFilesBatch(ctx, user, []string{allowed.FileID}, "folder_secret", "all_or_nothing", "")
	if err != nil {
		t.Fatal(err)
	}
	if blocked.Status != "conflict" || len(blocked.Conflicts) != 1 || blocked.Conflicts[0].Code != "E_FORBIDDEN" {
		t.Fatalf("target without upload must be forbidden: %+v", blocked)
	}
	for _, placed := range []struct {
		uploaded UploadResult
		folder   string
	}{{forbidden, "folder_root"}, {allowed, "folder_market"}} {
		file, _, err := s.FileMeta(ctx, admin, placed.uploaded.FileID)
		if err != nil {
			t.Fatal(err)
		}
		if file.FolderID != placed.folder {
			t.Fatalf("forbidden batch must not move %s, folder = %s", placed.uploaded.FileID, file.FolderID)
		}
	}
	if totalAudit(repo) != before {
		t.Fatal("forbidden batch must not write audit rows")
	}
}

func TestMoveFilesBatchMissingFileAndTarget(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "kept.txt", "text/plain", "", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	target, err := s.CreateFolder(ctx, admin, "folder_root", "批量目标")
	if err != nil {
		t.Fatal(err)
	}
	before := countAudit(repo, "file.move")
	result, err := s.MoveFilesBatch(ctx, admin, []string{uploaded.FileID, "file_missing"}, target.ID, "all_or_nothing", "")
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "conflict" || len(result.Conflicts) != 1 || result.Conflicts[0].ID != "file_missing" || result.Conflicts[0].Code != "E_NOT_FOUND" {
		t.Fatalf("missing file must be a per-item not-found conflict: %+v", result)
	}
	// A missing target conflicts every item.
	missingTarget, err := s.MoveFilesBatch(ctx, admin, []string{uploaded.FileID}, "folder_missing", "all_or_nothing", "")
	if err != nil {
		t.Fatal(err)
	}
	if missingTarget.Status != "conflict" || len(missingTarget.Conflicts) != 1 || missingTarget.Conflicts[0].Code != "E_NOT_FOUND" {
		t.Fatalf("missing target must be a not-found conflict: %+v", missingTarget)
	}
	// A soft-deleted target is indistinguishable from a missing one.
	temporary, err := s.CreateFolder(ctx, admin, "folder_root", "临时目录")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.DeleteFolder(ctx, admin, temporary.ID); err != nil {
		t.Fatal(err)
	}
	deletedTarget, err := s.MoveFilesBatch(ctx, admin, []string{uploaded.FileID}, temporary.ID, "all_or_nothing", "")
	if err != nil {
		t.Fatal(err)
	}
	if deletedTarget.Status != "conflict" || len(deletedTarget.Conflicts) != 1 || deletedTarget.Conflicts[0].Code != "E_NOT_FOUND" {
		t.Fatalf("deleted target must be a not-found conflict: %+v", deletedTarget)
	}
	file, _, err := s.FileMeta(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatal(err)
	}
	if file.FolderID != "folder_root" || countAudit(repo, "file.move") != before {
		t.Fatal("a batch with a missing file or target must not move anything or write audit rows")
	}
}

func TestMoveFilesBatchIntraBatchNameCollision(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	first, err := s.CommitUpload(ctx, admin, "folder_root", "same.txt", "text/plain", "", strings.NewReader("a"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CommitUpload(ctx, admin, "folder_market", "same.txt", "text/plain", "", strings.NewReader("b"))
	if err != nil {
		t.Fatal(err)
	}
	target, err := s.CreateFolder(ctx, admin, "folder_root", "批量目标")
	if err != nil {
		t.Fatal(err)
	}
	before := totalAudit(repo)
	result, err := s.MoveFilesBatch(ctx, admin, []string{first.FileID, second.FileID}, target.ID, "all_or_nothing", "")
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "conflict" || len(result.Conflicts) != 1 || result.Conflicts[0].ID != second.FileID || result.Conflicts[0].Code != "E_NAME_CONFLICT" {
		t.Fatalf("the later intra-batch name duplicate must conflict: %+v", result)
	}
	if totalAudit(repo) != before {
		t.Fatal("intra-batch name conflict must not write audit rows")
	}
	for _, uploaded := range []UploadResult{first, second} {
		file, _, err := s.FileMeta(ctx, admin, uploaded.FileID)
		if err != nil {
			t.Fatal(err)
		}
		if file.FolderID == target.ID {
			t.Fatalf("intra-batch conflict must not move %s", uploaded.FileID)
		}
	}
}

func TestMoveFilesBatchRejectsBadInput(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	before := totalAudit(repo)
	if _, err := s.MoveFilesBatch(ctx, admin, nil, "folder_market", "", ""); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("empty fileIds must be rejected, got %v", err)
	}
	if _, err := s.MoveFilesBatch(ctx, admin, []string{"file_x"}, "", "", ""); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("empty target must be rejected, got %v", err)
	}
	if _, err := s.MoveFilesBatch(ctx, admin, []string{"file_x"}, "folder_market", "best_effort", ""); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("unknown mode must be rejected, got %v", err)
	}
	if _, err := s.MoveFilesBatch(ctx, admin, []string{"file_x", "file_x"}, "folder_market", "all_or_nothing", ""); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("duplicate fileIds must be rejected, got %v", err)
	}
	over := make([]string, 0, MaxMoveBatchFiles+1)
	for i := 0; i <= MaxMoveBatchFiles; i++ {
		over = append(over, fmt.Sprintf("file_over_%d", i))
	}
	_, err := s.MoveFilesBatch(ctx, admin, over, "folder_market", "all_or_nothing", "")
	if !errors.Is(err, ErrBatchTooLarge) || !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("over-limit batch must be rejected as invalid input, got %v", err)
	}
	if message := err.Error(); !strings.Contains(message, fmt.Sprint(MaxMoveBatchFiles)) {
		t.Fatalf("over-limit message must state the limit, got %q", message)
	}
	if totalAudit(repo) != before {
		t.Fatal("rejected batches must not write audit rows")
	}
}

func TestMoveFilesBatchIdempotentReplay(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	first, err := s.CommitUpload(ctx, admin, "folder_root", "replay-one.txt", "text/plain", "", strings.NewReader("a"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CommitUpload(ctx, admin, "folder_market", "replay-two.txt", "text/plain", "", strings.NewReader("b"))
	if err != nil {
		t.Fatal(err)
	}
	target, err := s.CreateFolder(ctx, admin, "folder_root", "批量目标")
	if err != nil {
		t.Fatal(err)
	}
	fileIDs := []string{first.FileID, second.FileID}
	before := totalAudit(repo)
	firstCall, err := s.MoveFilesBatch(ctx, admin, fileIDs, target.ID, "all_or_nothing", "key-batch-replay")
	if err != nil {
		t.Fatal(err)
	}
	// The replay returns the recorded result even though the files no longer sit
	// in their original folders.
	again, err := s.MoveFilesBatch(ctx, admin, fileIDs, target.ID, "all_or_nothing", "key-batch-replay")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(firstCall, again) {
		t.Fatalf("idempotent replay must return the same result: %+v vs %+v", firstCall, again)
	}
	if countAudit(repo, "file.move") != 2 || totalAudit(repo) != before+2 {
		t.Fatal("replay must not duplicate audit rows")
	}
	for _, uploaded := range []UploadResult{first, second} {
		file, versions, err := s.FileMeta(ctx, admin, uploaded.FileID)
		if err != nil {
			t.Fatal(err)
		}
		if file.FolderID != target.ID || len(versions) != 1 {
			t.Fatal("replay must not re-apply the move or touch history")
		}
	}
}
