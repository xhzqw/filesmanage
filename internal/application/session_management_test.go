package application

import (
	"context"
	"errors"
	"filesmanage/internal/ports"
	"testing"
)

func TestSessionInventoryOwnershipAndAudit(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	first, _, err := s.Login(WithLoginMetadata(ctx, "192.168.1.23", "Mozilla/5.0 (Windows NT 10.0) Chrome/125.0"), "user1", "long-unit-test-password")
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := s.Login(ctx, "user1", "long-unit-test-password")
	if err != nil {
		t.Fatal(err)
	}
	admin, _, err := s.Login(ctx, "admin", "long-unit-test-password")
	if err != nil {
		t.Fatal(err)
	}
	rows, err := s.ListMySessions(ctx, first)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("visible own sessions=%d, want 2", len(rows))
	}
	var otherID, currentID string
	for _, v := range rows {
		if v.Current {
			currentID = v.ID
		} else {
			otherID = v.ID
		}
	}
	if len(currentID) != 24 || len(otherID) != 24 || currentID == otherID {
		t.Fatalf("invalid ids: current=%q other=%q", currentID, otherID)
	}
	if err = s.RevokeMySession(ctx, first, currentID); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("current device removable: %v", err)
	}
	if err = s.RevokeMySession(ctx, admin, otherID); !errors.Is(err, ports.ErrRowMissing) {
		t.Fatalf("cross-user revoke must be indistinguishable: %v", err)
	}
	if err = s.RevokeMySession(ctx, first, otherID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Session(ctx, second); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("revoked device authorized: %v", err)
	}
	if _, err = s.Session(ctx, first); err != nil {
		t.Fatalf("current device revoked: %v", err)
	}
	if err = s.RevokeMySession(ctx, first, otherID); !errors.Is(err, ports.ErrRowMissing) {
		t.Fatalf("repeat revoke must be 404: %v", err)
	}
	recent, err := s.ListMyAuthActivity(ctx, first)
	if err != nil {
		t.Fatal(err)
	}
	if len(recent) < 3 {
		t.Fatalf("expected logins and revocation, got %d", len(recent))
	}
	if recent[0].Type != "auth.session_revoke" {
		t.Fatalf("latest event=%q", recent[0].Type)
	}
	for _, event := range recent {
		if event.Type == "auth.login" && event.Device == "Chrome · Windows" && event.Address == "192.168.1.23" {
			return
		}
	}
	t.Fatal("missing coarse successful login metadata")
}

func TestRevokeOtherSessionsKeepsCurrentAndNotifies(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	first, _, _ := s.Login(ctx, "user1", "long-unit-test-password")
	second, _, _ := s.Login(ctx, "user1", "long-unit-test-password")
	third, _, _ := s.Login(ctx, "user1", "long-unit-test-password")
	admin, _, _ := s.Login(ctx, "admin", "long-unit-test-password")
	events, stop := s.SubscribeUserEvents("u_user")
	defer stop()
	count, err := s.RevokeOtherMySessions(ctx, first)
	if err != nil || count != 2 {
		t.Fatalf("revoke others count=%d error=%v", count, err)
	}
	awaitUserEvent(t, events, "session.changed")
	for _, token := range []string{second, third} {
		if _, err = s.Session(ctx, token); !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("other session still live: %v", err)
		}
	}
	for _, token := range []string{first, admin} {
		if _, err = s.Session(ctx, token); err != nil {
			t.Fatalf("protected session invalid: %v", err)
		}
	}
	count, err = s.RevokeOtherMySessions(ctx, first)
	if err != nil || count != 0 {
		t.Fatalf("repeated revoke count=%d err=%v", count, err)
	}
}

func TestDeviceLabelIsBounded(t *testing.T) {
	for _, tc := range []struct{ agent, want string }{
		{"Mozilla Windows Chrome/120", "Chrome · Windows"},
		{"Mozilla Macintosh Safari/605", "Safari · macOS"},
		{"Mozilla Android Firefox/110", "Firefox · Android"},
		{"Mozilla Edg/116 Windows", "Edge · Windows"},
		{"unrecognized", "浏览器 · 其他设备"},
	} {
		if got := deviceLabel(tc.agent); got != tc.want {
			t.Fatalf("label for %q=%q want=%q", tc.agent, got, tc.want)
		}
	}
}
