package application

import (
	"context"
	"errors"
	"strings"
	"testing"

	"filesmanage/internal/domain"
)

// TestExportStreamsAuthorizedRows locks the SPEC §3.10 export contract: every
// filtered row is streamed (no 200-row clamp), the seven columns are present,
// formula-looking names are neutralised, and versions reflect the current seq.
func TestExportStreamsAuthorizedRows(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	names := []string{"预算.txt", "=cmd|' /C calc'!A0.txt", "no-extension"}
	for _, name := range names {
		if _, err := s.CommitUpload(ctx, admin, "folder_market", name, "text/plain", "", strings.NewReader(name)); err != nil {
			t.Fatal(err)
		}
	}
	var got [][]string
	n, err := s.ExportCSVStream(ctx, admin, SearchFilter{FolderID: "folder_market"}, func(fields []string) error {
		got = append(got, fields)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if n != len(names) || len(got) != len(names) {
		t.Fatalf("stream must yield every filtered row: count=%d rows=%d", n, len(got))
	}
	neutralised := false
	for _, fields := range got {
		if len(fields) != 7 {
			t.Fatalf("export row must carry the seven SPEC §3.10 columns, got %d", len(fields))
		}
		if fields[6] != "1" {
			t.Fatalf("uploaded file must export version 1, got %q", fields[6])
		}
		if fields[0] == "预算.txt" && fields[5] != ".txt" {
			t.Fatalf("extension column must report the lowercase suffix, got %q", fields[5])
		}
		if strings.HasPrefix(fields[0], "'=cmd") {
			neutralised = true
		}
	}
	if !neutralised {
		t.Fatal("formula-looking file name must be neutralised in the CSV stream")
	}
	// The success path audits the export with its row count.
	repo.mu.Lock()
	defer repo.mu.Unlock()
	audited := false
	for _, e := range repo.audit {
		if e.EventType == "files.export" && e.Outcome == "success" {
			audited = true
		}
	}
	if !audited {
		t.Fatal("a successful export must be audited")
	}
}

// TestExportStreamStopsWhenConsumerFails covers a client disconnect: the
// stream aborts instead of scanning the whole table for a dead connection.
func TestExportStreamStopsWhenConsumerFails(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		if _, err := s.CommitUpload(ctx, admin, "folder_market", name, "text/plain", "", strings.NewReader(name)); err != nil {
			t.Fatal(err)
		}
	}
	seen := 0
	_, err := s.ExportCSVStream(ctx, admin, SearchFilter{FolderID: "folder_market"}, func([]string) error {
		seen++
		return errors.New("client gone")
	})
	if err == nil {
		t.Fatal("consumer failure must abort the export")
	}
	if seen != 1 {
		t.Fatalf("export must stop at the first failed write, saw %d rows", seen)
	}
}

// TestRecordExportFailureAuditsStreamBreak ensures a broken stream is visible
// in the audit trail: the status line is already committed at that point.
func TestRecordExportFailureAuditsStreamBreak(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	s.RecordExportFailure(context.Background(), admin, 12, errors.New("connection reset by peer"))
	repo.mu.Lock()
	defer repo.mu.Unlock()
	found := false
	for _, e := range repo.audit {
		if e.EventType == "files.export" && e.Outcome == "failed" {
			found = true
			if rows, ok := e.Details["rows"]; !ok || rows != 12 {
				t.Fatalf("failure audit must carry the streamed row count, got %v", e.Details["rows"])
			}
		}
	}
	if !found {
		t.Fatal("a broken export stream must be audited as failed")
	}
}

// TestFolderShareUsesOnePermissionPath locks SPEC §2.4: a folder share must
// grant list/preview on the shared folder and, with include_descendants, on
// its subtree — through the same resolution the document page uses, not only
// the search scope. Revocation takes effect on the next request.
func TestFolderShareUsesOnePermissionPath(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	member := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()

	sharedParent, err := s.CreateFolder(ctx, admin, "folder_market", "共享父目录")
	if err != nil {
		t.Fatal(err)
	}
	sharedChild, err := s.CreateFolder(ctx, admin, sharedParent.ID, "共享子目录")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.CommitUpload(ctx, admin, sharedChild.ID, "share.txt", "text/plain", "", strings.NewReader("shared")); err != nil {
		t.Fatal(err)
	}
	// A second subtree shared WITHOUT descendants.
	closedParent, err := s.CreateFolder(ctx, admin, "folder_market", "不蔓延父目录")
	if err != nil {
		t.Fatal(err)
	}
	closedChild, err := s.CreateFolder(ctx, admin, closedParent.ID, "不蔓延子目录")
	if err != nil {
		t.Fatal(err)
	}

	if _, err = s.CreateShare(ctx, admin, ShareDraft{
		ResourceKind: "folder", ResourceID: sharedParent.ID,
		RecipientKind: "user", RecipientID: member.ID,
		Actions: []domain.Action{domain.ActionList, domain.ActionPreview}, IncludeDescendants: true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateShare(ctx, admin, ShareDraft{
		ResourceKind: "folder", ResourceID: closedParent.ID,
		RecipientKind: "user", RecipientID: member.ID,
		Actions: []domain.Action{domain.ActionList, domain.ActionPreview}, IncludeDescendants: false,
	}); err != nil {
		t.Fatal(err)
	}

	page, err := s.ListFiles(ctx, member, sharedChild.ID, "", FileCursor{}, 50)
	if err != nil {
		t.Fatalf("descendant of a shared folder must be listable: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("shared child folder must expose its file, got %d rows", len(page.Items))
	}
	// Without include_descendants the child stays closed.
	if _, err = s.ListFiles(ctx, member, closedChild.ID, "", FileCursor{}, 50); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("child of a non-inheriting share must stay forbidden, got %v", err)
	}

	shares, err := s.ListShares(ctx, admin, "sent")
	if err != nil || len(shares) != 2 {
		t.Fatalf("expected two sent shares, got %d (%v)", len(shares), err)
	}
	for _, share := range shares {
		if err = s.RevokeShare(ctx, admin, share.ID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = s.ListFiles(ctx, member, sharedChild.ID, "", FileCursor{}, 50); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("revoked share must deny the child folder immediately, got %v", err)
	}
}

// TestFileShareGrantsPreviewOutsideFolderScope covers the directly shared file
// that lives in a folder the recipient cannot list (SPEC §2.4).
func TestFileShareGrantsPreviewOutsideFolderScope(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	member := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()
	uploaded, err := s.CommitUpload(ctx, admin, "folder_market", "shared.bin", "application/octet-stream", "", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Preview(ctx, member, uploaded.FileID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("unshared file must stay forbidden, got %v", err)
	}
	fileID := uploaded.FileID
	if _, err = s.CreateShare(ctx, admin, ShareDraft{
		ResourceKind: "file", ResourceID: fileID,
		RecipientKind: "user", RecipientID: member.ID,
		Actions: []domain.Action{domain.ActionPreview, domain.ActionDownload},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Preview(ctx, member, uploaded.FileID); err != nil {
		t.Fatalf("file share must grant preview: %v", err)
	}
}
