package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"io"
	"strings"
	"testing"
)

func TestApprovalDraftReviewUsesRecordedBase(t *testing.T) {
	svc, repo := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	requester := domain.User{ID: "u_user"}
	stranger := domain.User{ID: "u_stranger"}
	repo.seedGrant(domain.ACL{ID: "review-allow", FolderID: "folder_root", SubjectKind: "user", SubjectID: requester.ID,
		Actions: []domain.Action{domain.ActionList, domain.ActionModify, domain.ActionDownload, domain.ActionPreview}})
	uploaded, err := svc.CommitUpload(ctx, admin, "folder_root", "compare.txt", "text/plain", "", strings.NewReader("first\nunchanged"))
	if err != nil {
		t.Fatal(err)
	}
	if err = svc.SetApprovalChainPolicy(ctx, admin, "folder_root", []string{admin.ID}, true); err != nil {
		t.Fatal(err)
	}
	pending, err := svc.Save(ctx, requester, uploaded.FileID, []byte("revised\nunchanged"), 1, "", "needs approval")
	if err != nil || pending.Approval == nil {
		t.Fatalf("pending %+v %v", pending, err)
	}
	id := pending.Approval.ID
	if _, err = svc.CompareApprovalDraft(ctx, stranger, id); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("unauthorized compare: %v", err)
	}
	if _, err = svc.PreviewApprovalDraft(ctx, stranger, id); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("unauthorized preview: %v", err)
	}
	comparison, err := svc.CompareApprovalDraft(ctx, admin, id)
	if err != nil {
		t.Fatal(err)
	}
	if comparison.Left.Seq != 1 || comparison.Right.Seq != 0 || comparison.Mode != "text" || comparison.Added != 1 || comparison.Removed != 1 {
		t.Fatalf("incorrect pending diff %+v", comparison)
	}
	draft, err := svc.PreviewApprovalDraft(ctx, admin, id)
	if err != nil || draft.Renderer != "text" || draft.Content != "revised\nunchanged" {
		t.Fatalf("pending preview %+v %v", draft, err)
	}
	published, err := svc.Preview(ctx, admin, uploaded.FileID)
	if err != nil || published.Content != "first\nunchanged" {
		t.Fatalf("pending overwrote released bytes %+v %v", published, err)
	}
	if _, closeFn, err := svc.OpenInlineApprovalDraft(ctx, admin, id); !errors.Is(err, ErrPreviewUnsupported) {
		if closeFn != nil {
			closeFn()
		}
		t.Fatalf("text must not be streamed as passive media: %v", err)
	}
	if _, err = svc.Approve(ctx, admin, id, "reviewed"); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.CompareApprovalDraft(ctx, admin, id); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("terminal diff: %v", err)
	}
	if _, err = svc.PreviewApprovalDraft(ctx, admin, id); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("terminal preview: %v", err)
	}
}

func TestApprovalDraftMediaRequiresPreviewPermission(t *testing.T) {
	svc, repo := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	requester := domain.User{ID: "u_user"}
	repo.seedGrant(domain.ACL{ID: "draft-media-download-only", FolderID: "folder_root", SubjectKind: "user", SubjectID: requester.ID,
		Actions: []domain.Action{domain.ActionList, domain.ActionModify, domain.ActionDownload}})
	image := append([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}, []byte("image fixture")...)
	file, err := svc.CommitUpload(ctx, admin, "folder_root", "approval-photo.png", "image/png", "", strings.NewReader("old data"))
	if err != nil {
		t.Fatal(err)
	}
	if err = svc.SetApprovalChainPolicy(ctx, admin, "folder_root", []string{admin.ID}, true); err != nil {
		t.Fatal(err)
	}
	pending, err := svc.Save(ctx, requester, file.FileID, image, 1, "", "inspect image")
	if err != nil || pending.Approval == nil {
		t.Fatalf("submit %+v %v", pending, err)
	}
	id := pending.Approval.ID
	if _, err = svc.PreviewApprovalDraft(ctx, requester, id); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("missing preview rights %v", err)
	}
	if _, closeFn, err := svc.OpenInlineApprovalDraft(ctx, requester, id); !errors.Is(err, domain.ErrForbidden) {
		if closeFn != nil {
			closeFn()
		}
		t.Fatalf("missing preview rights allowed media: %v", err)
	}
	media, closeFn, err := svc.OpenInlineApprovalDraft(ctx, admin, id)
	if err != nil {
		t.Fatal(err)
	}
	payload, readErr := io.ReadAll(media.Reader)
	closeFn()
	if readErr != nil || string(payload) != string(image) || media.ContentType != "image/png" {
		t.Fatalf("media mismatch %v, %s", readErr, media.ContentType)
	}
}
