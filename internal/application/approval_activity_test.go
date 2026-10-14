package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"strings"
	"testing"
)

func TestApprovalEventHistoryAndScopedNotifications(t *testing.T) {
	s, repo := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	requester := domain.User{ID: "u_user"}
	outsider := domain.User{ID: "unrelated"}
	repo.seedGrant(domain.ACL{ID: "activity-grant", FolderID: "folder_root", SubjectKind: "user", SubjectID: requester.ID, Actions: []domain.Action{domain.ActionList, domain.ActionModify}})
	file, err := s.CommitUpload(ctx, admin, "folder_root", "approval-history-test.txt", "text/plain", "", strings.NewReader("old"))
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetApprovalChainPolicy(ctx, admin, "folder_root", []string{admin.ID, requester.ID}, true); err != nil {
		t.Fatal(err)
	}
	submitted, err := s.Save(ctx, requester, file.FileID, []byte("new"), 1, "", "please review")
	if err != nil || submitted.Approval == nil {
		t.Fatalf("save %v %+v", err, submitted)
	}
	id := submitted.Approval.ID
	if _, err = s.ApprovalDetail(ctx, outsider, id); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("unauthorized approval detail: %v", err)
	}
	if detail, detailErr := s.ApprovalDetail(ctx, admin, id); detailErr != nil || detail.ID != id {
		t.Fatalf("participant detail %+v %v", detail, detailErr)
	}
	if _, err = s.ApprovalHistory(ctx, outsider, id); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("unauthorized timeline: %v", err)
	}
	notes, err := s.ApprovalNotifications(ctx, admin)
	if err != nil || len(notes) != 1 || notes[0].Kind != "submitted" {
		t.Fatalf("first notification %+v %v", notes, err)
	}
	if err = s.ReadApprovalNotification(ctx, outsider, notes[0].ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("cross-user mark-read: %v", err)
	}
	if err = s.ReadApprovalNotification(ctx, admin, notes[0].ID); err != nil {
		t.Fatal(err)
	}
	notes, err = s.ApprovalNotifications(ctx, admin)
	if err != nil || !notes[0].Read {
		t.Fatalf("read receipt %+v %v", notes, err)
	}
	if _, err = s.Approve(ctx, admin, id, "first checked"); err != nil {
		t.Fatal(err)
	}
	timeline, err := s.ApprovalHistory(ctx, requester, id)
	if err != nil || len(timeline) != 2 || timeline[0].Kind != "submitted" || timeline[1].Kind != "advanced" || timeline[1].Comment != "first checked" || timeline[1].StepIndex != 0 {
		t.Fatalf("progress timeline %+v %v", timeline, err)
	}
	mine, err := s.ApprovalNotifications(ctx, requester)
	if err != nil || len(mine) != 1 || mine[0].Kind != "advanced" {
		t.Fatalf("requester notified %+v %v", mine, err)
	}
	if _, err = s.Approve(ctx, requester, id, "final checked"); err != nil {
		t.Fatal(err)
	}
	if detail, detailErr := s.ApprovalDetail(ctx, admin, id); detailErr != nil || detail.State != domain.ApprovalApproved {
		t.Fatalf("completed approval not available to prior reviewer %+v %v", detail, detailErr)
	}
	timeline, err = s.ApprovalHistory(ctx, admin, id)
	if err != nil || len(timeline) != 3 || timeline[2].Kind != "approved" || timeline[2].StepIndex != 1 || timeline[2].Comment != "final checked" {
		t.Fatalf("final timeline %+v %v", timeline, err)
	}
	mine, err = s.ApprovalNotifications(ctx, requester)
	if err != nil || len(mine) != 2 || mine[0].Kind != "approved" {
		t.Fatalf("final notify %+v %v", mine, err)
	}
	if _, err = s.Approve(ctx, requester, id, "duplicate"); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("double approve %v", err)
	}
	again, _ := s.ApprovalHistory(ctx, requester, id)
	if len(again) != 3 {
		t.Fatalf("duplicate event rows: %d", len(again))
	}
}
