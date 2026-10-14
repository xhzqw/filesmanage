package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"strings"
	"testing"
)

func TestFileHistoryRenameAndTrashIdentity(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	upload, err := s.CommitUpload(ctx, admin, "folder_market", "history-old.txt", "text/plain", "", strings.NewReader("hello"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.RenameFile(ctx, admin, upload.FileID, "history-new.txt"); err != nil {
		t.Fatal(err)
	}
	entry, err := s.DeleteFile(ctx, admin, upload.FileID)
	if err != nil {
		t.Fatal(err)
	}
	page, err := s.FileHistory(ctx, admin, upload.FileID, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 3 || page.Items[0].EventType != "file.delete" || page.Items[1].EventType != "file.rename" {
		t.Fatalf("unexpected timeline: %+v", page)
	}
	if page.Items[1].Details["oldName"] != "history-old.txt" || page.Items[1].Details["newName"] != "history-new.txt" {
		t.Fatalf("rename did not retain both names: %+v", page.Items[1].Details)
	}
	if _, err = s.RestoreFromTrash(ctx, admin, entry.ID, RestoreRequest{}); err != nil {
		t.Fatal(err)
	}
	page, err = s.FileHistory(ctx, admin, upload.FileID, "", 1)
	if err != nil || page.NextCursor == "" || len(page.Items) != 1 || page.Items[0].EventType != "trash.restore" {
		t.Fatalf("trash restore missing from file timeline: %+v, %v", page, err)
	}
	older, err := s.FileHistory(ctx, admin, upload.FileID, page.NextCursor, 20)
	if err != nil || len(older.Items) != 3 || older.Items[0].EventType != "file.delete" {
		t.Fatalf("history cursor broken: %+v, %v", older, err)
	}
}

func TestFileHistoryAuthorizationAndCursor(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	viewer := domain.User{ID: "u_user"}
	upload, err := s.CommitUpload(ctx, admin, "folder_market", "history-private.txt", "text/plain", "", strings.NewReader("secret"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.FileHistory(ctx, viewer, upload.FileID, "", 20); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("history leaked to unauthorized viewer: %v", err)
	}
	for _, cursor := range []string{"invalid", "0", "-1"} {
		if _, err = s.FileHistory(ctx, admin, upload.FileID, cursor, 20); !errors.Is(err, domain.ErrInvalidInput) {
			t.Fatalf("accepted cursor %q: %v", cursor, err)
		}
	}
}

func TestDeletedFileHistoryFollowsTrashAccess(t *testing.T) {
	s, repo := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	viewer := domain.User{ID: "u_user"}
	uploaded, err := s.CommitUpload(ctx, admin, "folder_market", "trashed-history.txt", "text/plain", "", strings.NewReader("data"))
	if err != nil {
		t.Fatal(err)
	}
	entry, err := s.DeleteFile(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.FileHistory(ctx, viewer, uploaded.FileID, "", 30); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("unrelated user read deleted history: %v", err)
	}
	repo.mu.Lock()
	for i := range repo.trash {
		if repo.trash[i].ID == entry.ID {
			repo.trash[i].DeletedBy = viewer.ID
		}
	}
	repo.mu.Unlock()
	page, err := s.FileHistory(ctx, viewer, uploaded.FileID, "", 30)
	if err != nil || len(page.Items) != 2 || page.Items[0].EventType != "file.delete" {
		t.Fatalf("deleted file history not accessible to trash owner: %+v %v", page, err)
	}
	if page.Items[0].RequestID != "" {
		t.Fatal("viewer was given internal request ID")
	}
}

func TestFileHistoryCapturesFolderCascadeAtEventTime(t *testing.T) {
	s, repo := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	original := "folder_market"
	repo.seedFolder(domain.Folder{ID: "history_subfolder", Name: "Old folder", ParentID: &original})
	upload, err := s.CommitUpload(ctx, admin, "history_subfolder", "child.txt", "text/plain", "", strings.NewReader("child"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.RenameFolder(ctx, admin, "history_subfolder", "New folder"); err != nil {
		t.Fatal(err)
	}
	page, err := s.FileHistory(ctx, admin, upload.FileID, "", 20)
	if err != nil || len(page.Items) < 2 || page.Items[0].EventType != "folder.rename" {
		t.Fatalf("folder rename absent from child timeline: %+v %v", page, err)
	}
	if page.Items[0].Details["oldName"] != "Old folder" {
		t.Fatalf("previous folder name lost: %+v", page.Items[0].Details)
	}
	// Move the child elsewhere. Historical folder membership must not be
	// re-derived from its new location when reading the old event.
	target := "folder_market"
	if _, err = s.MoveFile(ctx, admin, upload.FileID, target, "history_subfolder", ""); err != nil {
		t.Fatal(err)
	}
	page, err = s.FileHistory(ctx, admin, upload.FileID, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range page.Items {
		if e.EventType == "folder.rename" {
			found = true
		}
	}
	if !found {
		t.Fatal("folder history disappeared after moving the file")
	}
}

func TestFileHistoryMoveStoresHistoricalPathSnapshot(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	uploaded, err := s.CommitUpload(ctx, admin, "folder_market", "move-history.txt", "text/plain", "", strings.NewReader("v1"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.MoveFile(ctx, admin, uploaded.FileID, "folder_root", "folder_market", ""); err != nil {
		t.Fatal(err)
	}
	page, err := s.FileHistory(ctx, admin, uploaded.FileID, "", 20)
	if err != nil || len(page.Items) != 2 || page.Items[0].EventType != "file.move" {
		t.Fatalf("move history missing: %+v %v", page, err)
	}
	before, okA := page.Items[0].Details["fromPath"].(string)
	after, okB := page.Items[0].Details["toPath"].(string)
	if !okA || !okB || before == "" || after == "" || before == after {
		t.Fatalf("move path snapshot missing: %+v", page.Items[0].Details)
	}
	if _, err = s.RenameFolder(ctx, admin, "folder_market", "Renamed after move"); err != nil {
		t.Fatal(err)
	}
	page, err = s.FileHistory(ctx, admin, uploaded.FileID, "", 20)
	if err != nil || page.Items[0].Details["fromPath"] != before {
		t.Fatalf("historical path changed after folder rename: %+v %v", page, err)
	}
}
