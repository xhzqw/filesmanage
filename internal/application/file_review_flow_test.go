package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"strings"
	"testing"
)

func TestReviewFlowSelfAndAssignedAcceptance(t *testing.T) {
	ctx := context.Background()
	s, repo := testService(t)
	creator := domain.User{ID: "u_admin", IsAdmin: true}
	assignee := domain.User{ID: "u_user"}
	uploaded, err := s.CommitUpload(ctx, creator, "folder_root", "flow.txt", "text/plain", "", strings.NewReader("content"))
	if err != nil {
		t.Fatal(err)
	}
	repo.seedGrant(domain.ACL{ID: "acl_review_flow", FolderID: "folder_root", SubjectKind: "user", SubjectID: assignee.ID, Actions: []domain.Action{domain.ActionPreview}})
	candidates, err := s.ReviewAssignees(ctx, creator, uploaded.FileID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, candidate := range candidates {
		if candidate.ID == assignee.ID {
			found = true
			if candidate.Role != "成员" {
				t.Fatalf("incorrect role label: %+v", candidate)
			}
		}
	}
	if !found {
		t.Fatalf("permitted assignee missing from picker: %+v", candidates)
	}
	page := 1
	self, err := s.AddReviewFlowComment(ctx, creator, uploaded.FileID, 1, &page, nil, "自行处理", "")
	if err != nil || self.Status != domain.ReviewOpen {
		t.Fatalf("open: %+v %v", self, err)
	}
	if err = s.TransitionReviewComment(ctx, creator, uploaded.FileID, self.ID, "resolve-self", "已修复", nil, ""); err != nil {
		t.Fatal(err)
	}
	self, _ = repo.ReviewCommentByID(ctx, self.ID)
	if self.Status != domain.ReviewCompletedSelf || self.ResolvedAt == nil {
		t.Fatalf("self complete: %+v", self)
	}
	if err = s.TransitionReviewComment(ctx, creator, uploaded.FileID, self.ID, "reopen", "", nil, ""); err != nil {
		t.Fatal(err)
	}
	self, _ = repo.ReviewCommentByID(ctx, self.ID)
	if self.Status != domain.ReviewOpen || self.ResolvedAt != nil {
		t.Fatalf("reopen: %+v", self)
	}
	assigned, err := s.AddReviewFlowComment(ctx, creator, uploaded.FileID, 1, &page, nil, "修订数据", assignee.ID)
	if err != nil || assigned.Status != domain.ReviewAssigned {
		t.Fatalf("assigned: %+v %v", assigned, err)
	}
	if err = s.TransitionReviewComment(ctx, assignee, uploaded.FileID, assigned.ID, "approve", "", nil, ""); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("unauthorized approval: %v", err)
	}
	if err = s.TransitionReviewComment(ctx, creator, uploaded.FileID, assigned.ID, "approve", "", nil, ""); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("illegal state: %v", err)
	}
	if err = s.TransitionReviewComment(ctx, assignee, uploaded.FileID, assigned.ID, "submit-resolution", "", nil, ""); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("empty receipt: %v", err)
	}
	if err = s.TransitionReviewComment(ctx, assignee, uploaded.FileID, assigned.ID, "submit-resolution", "修订完成", nil, ""); err != nil {
		t.Fatal(err)
	}
	assigned, _ = repo.ReviewCommentByID(ctx, assigned.ID)
	if assigned.Status != domain.ReviewPendingApproval || assigned.ResolutionNote != "修订完成" {
		t.Fatalf("pending: %+v", assigned)
	}
	if err = s.TransitionReviewComment(ctx, creator, uploaded.FileID, assigned.ID, "reject", "请补充说明", nil, ""); err != nil {
		t.Fatal(err)
	}
	assigned, _ = repo.ReviewCommentByID(ctx, assigned.ID)
	if assigned.Status != domain.ReviewRejected || assigned.ApprovalNote != "请补充说明" {
		t.Fatalf("rejected: %+v", assigned)
	}
	if err = s.TransitionReviewComment(ctx, assignee, uploaded.FileID, assigned.ID, "submit-resolution", "已补齐", nil, ""); err != nil {
		t.Fatal(err)
	}
	if err = s.TransitionReviewComment(ctx, creator, uploaded.FileID, assigned.ID, "approve", "验收通过", nil, ""); err != nil {
		t.Fatal(err)
	}
	assigned, _ = repo.ReviewCommentByID(ctx, assigned.ID)
	if assigned.Status != domain.ReviewApproved || assigned.ApprovedAt == nil {
		t.Fatalf("approved: %+v", assigned)
	}
	if err = s.TransitionReviewComment(ctx, assignee, uploaded.FileID, assigned.ID, "submit-resolution", "重复提交", nil, ""); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("replayed submit: %v", err)
	}
	notices, count, err := repo.ReviewNotifications(ctx, creator.ID, 30)
	if err != nil || count < 2 || len(notices) < 2 {
		t.Fatalf("missing creator notifications: %d %+v %v", count, notices, err)
	}
	if notices[0].Kind != "submit-resolution" {
		t.Fatalf("last returned event: %+v", notices[0])
	}
}

func TestReviewFlowRejectsUnauthorizedAssignee(t *testing.T) {
	ctx := context.Background()
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "confidential.txt", "text/plain", "", strings.NewReader("x"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.AddReviewFlowComment(ctx, admin, uploaded.FileID, 1, nil, nil, "process", "u_user"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("should not assign without preview access: %v", err)
	}
}

func TestReviewReassignmentPreservesReceiptAndNotificationACL(t *testing.T) {
	ctx := context.Background()
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	first := domain.User{ID: "u_user"}
	second := domain.User{ID: "u_other", DisplayName: "第二处理人", Login: "other"}
	repo.seedUser(second, "")
	file, err := s.CommitUpload(ctx, admin, "folder_root", "review-transfer.txt", "text/plain", "", strings.NewReader("content"))
	if err != nil {
		t.Fatal(err)
	}
	repo.seedGrant(domain.ACL{ID: "review-first", FolderID: "folder_root", SubjectKind: "user", SubjectID: first.ID, Actions: []domain.Action{domain.ActionPreview}})
	repo.seedGrant(domain.ACL{ID: "review-second", FolderID: "folder_root", SubjectKind: "user", SubjectID: second.ID, Actions: []domain.Action{domain.ActionPreview}})
	comment, err := s.AddReviewFlowComment(ctx, admin, file.FileID, 1, nil, nil, "请核实", first.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.TransitionReviewComment(ctx, first, file.FileID, comment.ID, "submit-resolution", "第一人已修改", nil, ""); err != nil {
		t.Fatal(err)
	}
	if err = s.TransitionReviewComment(ctx, admin, file.FileID, comment.ID, "reject", "还有问题", nil, ""); err != nil {
		t.Fatal(err)
	}
	if err = s.TransitionReviewComment(ctx, admin, file.FileID, comment.ID, "assign", "", nil, second.ID); err != nil {
		t.Fatal(err)
	}
	updated, err := repo.ReviewCommentByID(ctx, comment.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Status != domain.ReviewAssigned || updated.AssigneeID != second.ID || updated.ResolutionNote != "" || updated.ResolvedBy != "" || updated.ResolvedAt != nil {
		t.Fatalf("reassignment has stale receipt: %+v", updated)
	}
	events, err := s.ReviewCommentEvents(ctx, admin, file.FileID, comment.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 4 || events[1].ResolutionNote != "第一人已修改" || events[1].ResolvedBy != first.ID ||
		events[2].ApprovalNote != "还有问题" || events[3].AssigneeID != second.ID {
		t.Fatalf("immutable history lost or wrongly attributed: %+v", events)
	}
	notices, err := s.ReviewNotices(ctx, second)
	if err != nil || len(notices.Items) == 0 || notices.Items[0].FileID == "" {
		t.Fatalf("expected visible notice: %+v %v", notices, err)
	}
	repo.mu.Lock()
	delete(repo.grants, "review-second")
	repo.mu.Unlock()
	notices, err = s.ReviewNotices(ctx, second)
	if err != nil || len(notices.Items) == 0 || notices.Items[0].FileID != "" || notices.Items[0].Kind != "access_revoked" {
		t.Fatalf("notice leaked a revoked resource: %+v %v", notices, err)
	}
}

func TestReviewServerFilteredPaginationAndLegacyModify(t *testing.T) {
	ctx := context.Background()
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	user := domain.User{ID: "u_user"}
	file, err := s.CommitUpload(ctx, admin, "folder_root", "filter.txt", "text/plain", "", strings.NewReader("content"))
	if err != nil {
		t.Fatal(err)
	}
	repo.seedGrant(domain.ACL{ID: "review-view-modify", FolderID: "folder_root", SubjectKind: "user", SubjectID: user.ID,
		Actions: []domain.Action{domain.ActionPreview, domain.ActionModify}})
	for i := 0; i < 35; i++ {
		if _, err = s.AddReviewFlowComment(ctx, admin, file.FileID, 1, nil, nil, "打开项", ""); err != nil {
			t.Fatal(err)
		}
	}
	assigned, err := s.AddReviewFlowComment(ctx, admin, file.FileID, 1, nil, nil, "待我处理", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	page, err := s.ReviewWorkflowComments(ctx, user, file.FileID, 1, "", 1, "mine")
	if err != nil || page.Counts.All != 36 || page.Counts.Mine != 1 || len(page.Items) != 1 || page.Items[0].ID != assigned.ID {
		t.Fatalf("filtered page missed work beyond thirty: %+v %v", page, err)
	}
	if err = s.TransitionReviewComment(ctx, user, file.FileID, assigned.ID, "submit-resolution", "已完成", nil, ""); err != nil {
		t.Fatal(err)
	}
	page, err = s.ReviewWorkflowComments(ctx, admin, file.FileID, 1, "", 1, "approval")
	if err != nil || page.Counts.Approval != 1 || len(page.Items) != 1 || page.Items[0].ID != assigned.ID {
		t.Fatalf("approval counts wrong: %+v %v", page, err)
	}
	if err = s.ResolveReviewComment(ctx, user, file.FileID, 1); err != nil {
		t.Fatalf("legacy modify actor lost resolution rights: %v", err)
	}
	if _, err = s.ReviewWorkflowComments(ctx, user, file.FileID, 1, "", 10, "invalid"); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("invalid filter should fail: %v", err)
	}
}
