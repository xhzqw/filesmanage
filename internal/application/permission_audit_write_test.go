package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"testing"
)

func TestPermissionAuditCarriesRequestCorrelationAndSafeBeforeAfter(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	member := domain.User{ID: "u_user", Login: "user1"}
	ctx := WithAuditRequestID(context.Background(), "req-unit-correlation")
	grant, err := s.CreateGrant(ctx, admin, "folder_market", GrantRequest{
		SubjectKind: "user", SubjectID: member.ID, Actions: []domain.Action{domain.ActionList, domain.ActionDownload},
		ScopeOnly: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.RevokeGrant(ctx, admin, grant.ID); err != nil {
		t.Fatal(err)
	}
	share, err := s.CreateShare(ctx, admin, ShareDraft{
		ResourceKind: "folder", ResourceID: "folder_market", RecipientKind: "user",
		RecipientID: member.ID, Actions: []domain.Action{domain.ActionPreview},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.RevokeShare(ctx, admin, share.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.RecordPermissionDenial(ctx, member.ID, "acl.create", "folder", "folder_market"); err != nil {
		t.Fatal(err)
	}
	page, err := s.ListPermissionAudit(ctx, admin, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 5 {
		t.Fatalf("expected 4 mutations and one independent denial; got %d", len(page.Items))
	}
	kinds := map[string]bool{}
	for _, e := range page.Items {
		if e.RequestID != "req-unit-correlation" {
			t.Fatalf("request correlation missing: %+v", e)
		}
		if e.Outcome == "denied" {
			if e.EventType != "acl.create" || e.Details["reason"] != "forbidden" {
				t.Fatalf("denial metadata mismatch: %+v", e)
			}
			continue
		}
		if e.Outcome != "success" {
			t.Fatalf("unexpected audit result %+v", e)
		}
		if _, ok := e.Details["before"]; !ok {
			t.Fatalf("missing before snapshot: %+v", e)
		}
		if _, ok := e.Details["after"]; !ok {
			t.Fatalf("missing after snapshot: %+v", e)
		}
		if strings.Contains(strings.ToLower(e.EventType), "password") && strings.Contains(strings.ToLower(e.EventType), "credential") {
			t.Fatal("credential leaked into event type")
		}
		kinds[e.EventType] = true
	}
	for _, key := range []string{"acl.create", "acl.revoke", "share.create", "share.revoke"} {
		if !kinds[key] {
			t.Fatalf("missing audited event %s", key)
		}
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.audit) != 5 {
		t.Fatalf("denial must persist after the denied mutation, got %d", len(repo.audit))
	}
}

// The transaction abstraction below fails audit writes while spying on Commit.
// In memory, Rollback is a no-op, so this asserts no COMMIT was attempted;
// PostgreSQL transactional rollback is covered by the adapter contract.
type failingAuditUOW struct {
	ports.UnitOfWork
	commits *int
}
type failingAuditTx struct {
	ports.Tx
	commits *int
}

func (u failingAuditUOW) Begin(ctx context.Context) (ports.Tx, error) {
	tx, err := u.UnitOfWork.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return failingAuditTx{Tx: tx, commits: u.commits}, nil
}
func (tx failingAuditTx) RecordAudit(context.Context, domain.AuditEvent) error {
	return errors.New("synthetic audit storage failure")
}
func (tx failingAuditTx) Commit(ctx context.Context) error {
	*tx.commits++
	return tx.Tx.Commit(ctx)
}

func TestPermissionWritesFailClosedWhenAuditStorageFails(t *testing.T) {
	s, repo := testService(t)
	commits := 0
	s.uow = failingAuditUOW{UnitOfWork: repo, commits: &commits}
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	ctx := context.Background()
	if _, err := s.CreateGrant(ctx, admin, "folder_market", GrantRequest{
		SubjectKind: "user", SubjectID: "u_user", Actions: []domain.Action{domain.ActionList},
	}); err == nil {
		t.Fatal("grant mutation must not report success when audit fails")
	}
	if _, err := s.CreateShare(ctx, admin, ShareDraft{
		ResourceKind: "folder", ResourceID: "folder_market", RecipientKind: "user",
		RecipientID: "u_user", Actions: []domain.Action{domain.ActionList},
	}); err == nil {
		t.Fatal("share mutation must not report success when audit fails")
	}
	if err := s.SetUserDisabled(ctx, admin, "u_user", true); err == nil {
		t.Fatal("account suspension must not report success when audit fails")
	}
	if commits != 0 {
		t.Fatalf("audit failure must prevent transaction COMMIT: %d", commits)
	}
}
