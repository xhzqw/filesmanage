package application

import (
	"context"
	"filesmanage/internal/domain"
	"testing"
	"time"
)

func awaitUserEvent(t *testing.T, events <-chan UserEvent, expected string) {
	t.Helper()
	select {
	case event := <-events:
		if event.Type != expected {
			t.Fatalf("event=%q want=%q", event.Type, expected)
		}
	case <-time.After(time.Second):
		t.Fatalf("no %s event", expected)
	}
}

func TestUserEventsAreIsolatedAndReleased(t *testing.T) {
	s, _ := testService(t)
	mine, stop := s.SubscribeUserEvents("u_user")
	admin, stopAdmin := s.SubscribeUserEvents("u_admin")
	defer stopAdmin()

	token, _, err := s.Login(context.Background(), "user1", "long-unit-test-password")
	if err != nil {
		t.Fatal(err)
	}
	awaitUserEvent(t, mine, "session.changed")
	select {
	case event := <-admin:
		t.Fatalf("leaked a private session event to admin: %+v", event)
	default:
	}
	if err := s.Logout(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	awaitUserEvent(t, mine, "session.changed")
	stop()
	stop()
	if len(s.live.listeners["u_user"]) != 0 {
		t.Fatal("subscription leaked after close")
	}
	if len(s.live.listeners) != 1 {
		t.Fatal("unexpected subscription counts")
	}

	// Bounded delivery: many events while the subscriber is slow occupy only
	// one buffered slot and never block a write transaction.
	for i := 0; i < 300; i++ {
		s.notifySessionChange("u_admin")
	}
	if len(admin) != 1 {
		t.Fatalf("event queue grew to %d", len(admin))
	}
}

func TestCredentialChangesPublishAfterCommit(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	ch, stop := s.SubscribeUserEvents("u_user")
	defer stop()
	_, _, err := s.Login(ctx, "user1", "long-unit-test-password")
	if err != nil {
		t.Fatal(err)
	}
	awaitUserEvent(t, ch, "session.changed")
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	if err := s.SetUserDisabled(ctx, admin, "u_user", true); err != nil {
		t.Fatal(err)
	}
	awaitUserEvent(t, ch, "session.changed")
}
