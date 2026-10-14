package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"io"
	"strings"
	"testing"
)

func TestApprovalDraftAccessAndLifecycle(t *testing.T) {
	svc, repo := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	requester := domain.User{ID: "u_user"}
	outsider := domain.User{ID: "u_other"}
	repo.seedGrant(domain.ACL{ID: "draft-rights", FolderID: "folder_root", SubjectKind: "user", SubjectID: requester.ID,
		Actions: []domain.Action{domain.ActionList, domain.ActionModify, domain.ActionDownload}})
	uploaded, err := svc.CommitUpload(ctx, admin, "folder_root", "draft-check.txt", "text/plain", "", strings.NewReader("published"))
	if err != nil {
		t.Fatal(err)
	}
	if err = svc.SetApprovalChainPolicy(ctx, admin, "folder_root", []string{admin.ID}, true); err != nil {
		t.Fatal(err)
	}
	pending, err := svc.Save(ctx, requester, uploaded.FileID, []byte("not yet published"), 1, "", "review")
	if err != nil || pending.Approval == nil {
		t.Fatalf("submit pending: %+v %v", pending, err)
	}
	id := pending.Approval.ID
	if _, closeFn, err := svc.OpenApprovalDraft(ctx, outsider, id); !errors.Is(err, domain.ErrForbidden) {
		if closeFn != nil {
			closeFn()
		}
		t.Fatalf("unrelated user accessed pending content: %v", err)
	}
	draft, closeFn, err := svc.OpenApprovalDraft(ctx, admin, id)
	if err != nil {
		t.Fatalf("approver must be able to download draft: %v", err)
	}
	contents, readErr := io.ReadAll(draft.Reader)
	closeFn()
	if readErr != nil || string(contents) != "not yet published" {
		t.Fatalf("draft bytes %q: %v", contents, readErr)
	}
	current, currentClose, err := svc.OpenDownload(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatal(err)
	}
	published, readErr := io.ReadAll(current.Reader)
	currentClose()
	if readErr != nil || string(published) != "published" {
		t.Fatalf("draft leaked into current version: %q, %v", published, readErr)
	}
	own, ownClose, err := svc.OpenApprovalDraft(ctx, requester, id)
	if err != nil {
		t.Fatalf("requester with download permission should inspect own draft: %v", err)
	}
	ownClose()
	if own.Sha256 != draft.Sha256 {
		t.Fatalf("draft changed across readers")
	}
	if _, err = svc.Approve(ctx, admin, id, "reviewed exact bytes"); err != nil {
		t.Fatal(err)
	}
	if _, closeFn, err = svc.OpenApprovalDraft(ctx, admin, id); !errors.Is(err, domain.ErrNotFound) {
		if closeFn != nil {
			closeFn()
		}
		t.Fatalf("terminal request should no longer offer a draft: %v", err)
	}
}
