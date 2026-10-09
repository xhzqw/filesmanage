package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"testing"
)

func TestCachedSessionInvalidatedAfterCredentialResetAndSuspension(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	oldSession, _, err := s.Login(ctx, "user1", "long-unit-test-password")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Session(ctx, oldSession); err != nil {
		t.Fatal(err)
	}
	if err = s.ResetUserPassword(ctx, admin, "u_user", "new-test-password-000000"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Session(ctx, oldSession); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("cached session survived password reset: %v", err)
	}
	newSession, _, err := s.Login(ctx, "user1", "new-test-password-000000")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Session(ctx, newSession); err != nil {
		t.Fatal(err)
	}
	if err = s.SetUserDisabled(ctx, admin, "u_user", true); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Session(ctx, newSession); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("cached session survived disabling account: %v", err)
	}
	// Model a concurrent request that fetched old DB state before the commit
	// and inserted that stale state after sessionCache.dropUser().
	s.session.put(newSession, domain.Authenticated{User: domain.User{ID: "u_user"}},
		s.now(), s.epoch()-1)
	if _, err = s.Session(ctx, newSession); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("stale cache insertion bypassed auth epoch: %v", err)
	}
}
