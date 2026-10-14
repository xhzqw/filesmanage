package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestEditLockLifecycle(t *testing.T) {
	s, repo := testService(t)
	repo.seedGrant(domain.ACL{ID: "acl_mod", FolderID: "folder_root", SubjectKind: "user", SubjectID: "u_user",
		Actions: []domain.Action{domain.ActionList, domain.ActionModify}})

	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	other := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "lock.txt", "text/plain", "", strings.NewReader("v1"))
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := s.AcquireLock(ctx, admin, uploaded.FileID, 1)
	if err != nil {
		t.Fatalf("acquire failed: %v", err)
	}
	// Another user cannot take the live lock.
	if _, _, err = s.AcquireLock(ctx, other, uploaded.FileID, 1); !errors.Is(err, domain.ErrLocked) {
		t.Fatalf("second holder must be refused: %v", err)
	}
	// Re-acquiring your own live lock replaces it with a fresh token; the old
	// token stops working immediately.
	same, _, err := s.AcquireLock(ctx, admin, uploaded.FileID, 1)
	if err != nil || same == token {
		t.Fatalf("re-acquire must issue a fresh token: %v", err)
	}
	if _, err = s.Save(ctx, admin, uploaded.FileID, []byte("stale-token"), 1, token, ""); !errors.Is(err, domain.ErrLocked) {
		t.Fatalf("superseded token must stop working: %v", err)
	}
	// Saving with the live (fresh) token succeeds and releases it.
	if _, err = s.Save(ctx, admin, uploaded.FileID, []byte("v2"), 1, same, ""); err != nil {
		t.Fatalf("save with lock failed: %v", err)
	}
	if _, held, _ := s.LockStatus(ctx, admin, uploaded.FileID); held {
		t.Fatal("lock must be released after a successful save")
	}
	// After release the next save needs a fresh lock.
	if _, err = s.Save(ctx, admin, uploaded.FileID, []byte("v3"), 2, token, ""); !errors.Is(err, domain.ErrLocked) {
		t.Fatalf("stale token must be refused: %v", err)
	}
	// Release with a stale token must not free a newer holder's lock.
	fresh, _, err := s.AcquireLock(ctx, admin, uploaded.FileID, 2)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.ReleaseLock(ctx, admin, uploaded.FileID, token); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("stale token release must conflict: %v", err)
	}
	if _, held, _ := s.LockStatus(ctx, admin, uploaded.FileID); !held {
		t.Fatal("new holder's lock must survive a stale release")
	}
	if err = s.ReleaseLock(ctx, admin, uploaded.FileID, fresh); err != nil {
		t.Fatalf("release own lock failed: %v", err)
	}
}

func TestLockExpiryTakeover(t *testing.T) {
	s, repo := testService(t)
	repo.seedGrant(domain.ACL{ID: "acl_mod", FolderID: "folder_root", SubjectKind: "user", SubjectID: "u_user",
		Actions: []domain.Action{domain.ActionList, domain.ActionModify}})

	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	other := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "expire.txt", "text/plain", "", strings.NewReader("v1"))
	if err != nil {
		t.Fatal(err)
	}
	// Expire the holder's lease server-side.
	repo.mu.Lock()
	lock := repo.locks[uploaded.FileID]
	lock.ExpiresAt = s.now().Add(-time.Minute)
	repo.locks[uploaded.FileID] = lock
	repo.mu.Unlock()
	if _, _, err = s.AcquireLock(ctx, other, uploaded.FileID, 1); err != nil {
		t.Fatalf("expired lock must be taken over: %v", err)
	}
	if _, held, _ := s.LockStatus(ctx, admin, uploaded.FileID); !held {
		t.Fatal("takeover must make the file locked again")
	}
}

func TestApprovalWorkflow(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	requester := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()
	repo.seedGrant(domain.ACL{ID: "acl_mod", FolderID: "folder_root", SubjectKind: "user", SubjectID: "u_user",
		Actions: []domain.Action{domain.ActionList, domain.ActionModify}})
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "approval.txt", "text/plain", "", strings.NewReader("v1"))
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetApprovalPolicy(ctx, admin, "folder_root", "u_admin", true); err != nil {
		t.Fatalf("set policy failed: %v", err)
	}
	if err = s.SetApprovalPolicy(ctx, requester, "folder_root", "u_user", true); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("policy management must be admin-only: %v", err)
	}
	// The policy blocks the direct save path and creates a pending request.
	outcome, err := s.Save(ctx, requester, uploaded.FileID, []byte("pending-bytes"), 1, "irrelevant-lock-token", "")
	if err != nil {
		t.Fatalf("submit under policy failed: %v", err)
	}
	if outcome.Approval == nil || outcome.Approval.State != domain.ApprovalPending {
		t.Fatalf("expected a pending approval, got %+v", outcome)
	}
	if outcome.Result.VersionSeq != 0 {
		t.Fatal("pending submission must not commit a version")
	}
	file, versions, err := s.FileMeta(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatal(err)
	}
	if len(versions) != 1 || file.Sha256 != versions[0].Sha256 {
		t.Fatal("current version must stay untouched while pending")
	}
	// A second pending request is refused.
	if _, err = s.Save(ctx, requester, uploaded.FileID, []byte("again"), 1, "", ""); !errors.Is(err, domain.ErrApprovalPending) {
		t.Fatalf("duplicate pending request must conflict: %v", err)
	}
	// A non-approver cannot decide.
	if _, err = s.Approve(ctx, requester, outcome.Approval.ID, ""); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non-approver must be refused: %v", err)
	}
	// Approval commits a new version with the pending bytes.
	result, err := s.Approve(ctx, admin, outcome.Approval.ID, "同意")
	if err != nil {
		t.Fatalf("approve failed: %v", err)
	}
	if result.VersionSeq != 2 {
		t.Fatalf("approval must commit v2, got %d", result.VersionSeq)
	}
	// A second decision of the same request is a controlled conflict.
	if _, err = s.Approve(ctx, admin, outcome.Approval.ID, ""); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("double approval must conflict: %v", err)
	}
	_, versions, err = s.FileMeta(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatal(err)
	}
	if len(versions) != 2 {
		t.Fatalf("history must hold exactly two versions, got %d", len(versions))
	}
}

func TestApprovalRejectKeepsCurrentVersion(t *testing.T) {
	s, repo := testService(t)
	repo.seedGrant(domain.ACL{ID: "acl_mod", FolderID: "folder_root", SubjectKind: "user", SubjectID: "u_user",
		Actions: []domain.Action{domain.ActionList, domain.ActionModify}})

	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	requester := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "reject.txt", "text/plain", "", strings.NewReader("v1"))
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetApprovalPolicy(ctx, admin, "folder_root", "u_admin", true); err != nil {
		t.Fatal(err)
	}
	outcome, err := s.Save(ctx, requester, uploaded.FileID, []byte("rejected-bytes"), 1, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Reject(ctx, admin, outcome.Approval.ID, "内容需修改"); err != nil {
		t.Fatalf("reject failed: %v", err)
	}
	_, versions, err := s.FileMeta(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatal(err)
	}
	if len(versions) != 1 {
		t.Fatalf("rejection must not create a version, got %d", len(versions))
	}
	// Once rejected, the requester may submit again.
	if _, err = s.Save(ctx, requester, uploaded.FileID, []byte("retry-bytes"), 1, "", ""); err != nil {
		t.Fatalf("resubmit after rejection failed: %v", err)
	}
}

func TestConcurrentApprovalsOnlyOneWins(t *testing.T) {
	s, repo := testService(t)
	repo.seedGrant(domain.ACL{ID: "acl_mod", FolderID: "folder_root", SubjectKind: "user", SubjectID: "u_user",
		Actions: []domain.Action{domain.ActionList, domain.ActionModify}})

	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	requester := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "race.txt", "text/plain", "", strings.NewReader("v1"))
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetApprovalPolicy(ctx, admin, "folder_root", "u_admin", true); err != nil {
		t.Fatal(err)
	}
	outcome, err := s.Save(ctx, requester, uploaded.FileID, []byte("bytes"), 1, "", "")
	if err != nil {
		t.Fatal(err)
	}
	// Two approvers decide at the same time; exactly one may commit.
	var wg sync.WaitGroup
	results := make([]error, 2)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, results[i] = s.Approve(ctx, admin, outcome.Approval.ID, "")
		}(i)
	}
	wg.Wait()
	wins := 0
	for _, err := range results {
		if err == nil {
			wins++
		}
	}
	if wins != 1 {
		t.Fatalf("exactly one concurrent approval may commit, got %d (%v)", wins, results)
	}
	_, versions, err := s.FileMeta(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatal(err)
	}
	if len(versions) != 2 {
		t.Fatalf("only one version may be committed, got %d", len(versions))
	}
	_ = repo
}
