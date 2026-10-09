package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"strings"
	"testing"
)

// Share creation must not turn passive file access into manage_share or turn
// preview access into transferable download access.
func TestShareRequiresResourceOwnershipAndNoPrivilegeAmplification(t *testing.T) {
	s, repo := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	member := domain.User{ID: "u_user", Login: "user1"}
	rootID := "folder_root"
	repo.seedFolder(domain.Folder{ID: "folder_owned", Name: "Owned", ParentID: &rootID, OwnerID: member.ID})
	repo.seedGrant(domain.ACL{ID: "acl_owned", FolderID: "folder_owned", SubjectKind: "user",
		SubjectID: member.ID, ScopeOnly: true,
		Actions: []domain.Action{domain.ActionList, domain.ActionPreview, domain.ActionUpload}})
	repo.seedGrant(domain.ACL{ID: "acl_viewer", FolderID: "folder_root", SubjectKind: "user",
		SubjectID: member.ID, ScopeOnly: true,
		Actions: []domain.Action{domain.ActionList, domain.ActionPreview}})
	makeDraft := func(kind, resource string, actions ...domain.Action) ShareDraft {
		return ShareDraft{ResourceKind: kind, ResourceID: resource,
			RecipientKind: "user", RecipientID: admin.ID, Actions: actions}
	}
	assertDenied := func(d ShareDraft, expected error, label string) {
		t.Helper()
		repo.mu.Lock()
		count, auditCount := len(repo.shares), len(repo.audit)
		repo.mu.Unlock()
		if _, err := s.CreateShare(ctx, member, d); !errors.Is(err, expected) {
			t.Fatalf("%s: got %v, want %v", label, err, expected)
		}
		repo.mu.Lock()
		defer repo.mu.Unlock()
		if len(repo.shares) != count || len(repo.audit) != auditCount {
			t.Fatalf("%s: denied share changed persisted shares or success audit", label)
		}
	}
	assertDenied(makeDraft("folder", "folder_root", domain.ActionList), domain.ErrForbidden,
		"list rights do not grant sharing another owner's folder")
	assertDenied(makeDraft("folder", "folder_owned", domain.ActionDownload), domain.ErrForbidden,
		"owner cannot delegate missing download rights")
	assertDenied(makeDraft("folder", "folder_owned", domain.ActionModify), domain.ErrInvalidInput,
		"share never grants write rights")
	subtree := makeDraft("folder", "folder_owned", domain.ActionList)
	subtree.IncludeDescendants = true
	assertDenied(subtree, domain.ErrForbidden,
		"ordinary owner cannot delegate unverified descendant rights")
	if _, err := s.CreateShare(ctx, member, makeDraft("folder", "folder_owned", domain.ActionList)); err != nil {
		t.Fatalf("owner may share a right already held: %v", err)
	}
	upload, err := s.CommitUpload(ctx, member, "folder_owned", "owned-file.txt", "text/plain", "",
		strings.NewReader("file content"))
	if err != nil {
		t.Fatal(err)
	}
	assertDenied(makeDraft("file", upload.FileID, domain.ActionDownload), domain.ErrForbidden,
		"file owner cannot delegate absent download right")
	if _, err = s.CreateShare(ctx, member, makeDraft("file", upload.FileID, domain.ActionPreview)); err != nil {
		t.Fatalf("file owner may share a held preview action: %v", err)
	}
	adminFile, err := s.CommitUpload(ctx, admin, "folder_root", "private-file.txt", "text/plain", "",
		strings.NewReader("private"))
	if err != nil {
		t.Fatal(err)
	}
	assertDenied(makeDraft("file", adminFile.FileID, domain.ActionPreview), domain.ErrForbidden,
		"viewer must not reshare another owner's file")
}
