package application

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestKnownAccountFailedLoginIsAuditedWithoutPassword(t *testing.T) {
	s, repo := testService(t)
	ctx := WithLoginMetadata(context.Background(), "192.168.1.42", "Mozilla/5.0 (Windows NT 10.0) Chrome/125.0")
	secret := "this-is-deliberately-wrong-credential"
	_, _, err := s.Login(ctx, "user1", secret)
	if !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("wrong password returned %v", err)
	}
	repo.mu.Lock()
	if len(repo.audit) != 1 {
		repo.mu.Unlock()
		t.Fatalf("want 1 failed audit, got %d", len(repo.audit))
	}
	e := repo.audit[0]
	repo.mu.Unlock()
	if e.ActorID != "u_user" || e.EventType != "auth.login" || e.Outcome != "denied" {
		t.Fatalf("wrong failure audit: actor=%s type=%s outcome=%s", e.ActorID, e.EventType, e.Outcome)
	}
	if e.Details["ip"] != "192.168.1.42" || e.Details["device"] != "Chrome · Windows" {
		t.Fatalf("invalid sanitized audit metadata: %+v", e.Details)
	}
	for key, value := range e.Details {
		if strings.Contains(strings.ToLower(key), "password") || strings.Contains(strings.ToLower(key), "secret") ||
			strings.Contains(value.(string), secret) {
			t.Fatal("secret credentials must never be persisted")
		}
	}
	_, _, err = s.Login(ctx, "does-not-exist", secret)
	if !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("unknown account returned %v", err)
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.audit) != 1 {
		t.Fatalf("unknown account must not be attributed to another user, events=%d", len(repo.audit))
	}
}
