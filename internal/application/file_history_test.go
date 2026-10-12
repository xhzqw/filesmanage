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
