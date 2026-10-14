package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"strings"
	"testing"
)

func TestApprovalAdminOversightAndRejectAuthorization(t *testing.T) {
	s, repo := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	reviewer := domain.User{ID: "u_user"}
	grantID := "approval-reviewer-visibility"
	repo.seedGrant(domain.ACL{
		ID: grantID, FolderID: "folder_root", SubjectKind: "user",
		SubjectID: reviewer.ID, Actions: []domain.Action{domain.ActionList},
	})
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "review-guard.txt", "text/plain", "", strings.NewReader("v1"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetApprovalPolicy(ctx, admin, "folder_root", reviewer.ID, true); err != nil {
		t.Fatal(err)
	}
	submission, err := s.Save(ctx, admin, uploaded.FileID, []byte("v2"), 1, "", "review")
	if err != nil || submission.Approval == nil {
		t.Fatalf("pending submission: %+v %v", submission, err)
	}
	id := submission.Approval.ID
	if _, err := s.ListApprovals(ctx, reviewer, "all_pending"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("ordinary users must not enumerate other requests: %v", err)
	}
	pending, err := s.ListApprovals(ctx, admin, "all_pending")
	if err != nil || len(pending) != 1 || pending[0].ID != id {
		t.Fatalf("admin pending oversight: %+v %v", pending, err)
	}
	if err := s.Reject(ctx, reviewer, id, "  "); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("blank reject reason should fail: %v", err)
	}
	if err := s.Reject(ctx, reviewer, id, strings.Repeat("x", 2001)); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("oversized reject reason should fail: %v", err)
	}
	if err := s.RevokeGrant(ctx, admin, grantID); err != nil {
		t.Fatalf("revoke reviewer visibility: %v", err)
	}
	if err := s.Reject(ctx, reviewer, id, "No longer authorized"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("revoked reviewer must not reject: %v", err)
	}
	if _, err := s.Approve(ctx, reviewer, id, "approve"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("revoked reviewer must not approve: %v", err)
	}
	if err := s.Reject(ctx, admin, id, "  Needs rework  "); err != nil {
		t.Fatalf("admin decision: %v", err)
	}
	detail, err := s.ApprovalDetail(ctx, admin, id)
	if err != nil || detail.State != domain.ApprovalRejected || detail.DecisionComment != "Needs rework" {
		t.Fatalf("persisted rejection reason: %+v %v", detail, err)
	}
	pending, err = s.ListApprovals(ctx, admin, "all_pending")
	if err != nil || len(pending) != 0 {
		t.Fatalf("terminal decision should leave admin pending scope: %+v %v", pending, err)
	}
	_, versions, err := s.FileMeta(ctx, admin, uploaded.FileID)
	if err != nil || len(versions) != 1 {
		t.Fatalf("rejection must not commit new version: %d %v", len(versions), err)
	}
}
