package application

import (
	"context"
	"filesmanage/internal/domain"
	"strings"
	"testing"
	"time"
)

func awaitUserEvent(t *testing.T, events <-chan UserEvent, expected string) {
	t.Helper()
	select {
	case event := <-events:
		if event.Type != expected && event.Type != "state.resync" {
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
	// An active WebSocket has already validated (and cached) this session.
	if _, err := s.Session(context.Background(), token); err != nil {
		t.Fatal(err)
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
	// ACL invalidation and session revocation can coalesce into a full resync.
	select {
	case event := <-ch:
		if event.Type != "session.changed" && event.Type != "state.resync" {
			t.Fatalf("unexpected credential invalidation: %+v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("no credential invalidation")
	}
}

func TestWorkspaceEventsAreAnonymousAndCoalesced(t *testing.T) {
	s, _ := testService(t)
	first, stopFirst := s.SubscribeUserEvents("u_user")
	defer stopFirst()
	second, stopSecond := s.SubscribeUserEvents("u_admin")
	defer stopSecond()
	s.notifyWorkspaceChange("file", "stats")
	for _, ch := range []<-chan UserEvent{first, second} {
		select {
		case ev := <-ch:
			if ev.Type != "workspace.changed" || len(ev.Scopes) != 2 || ev.Scopes[0] != "file" {
				t.Fatalf("bad anonymous invalidation: %+v", ev)
			}
		case <-time.After(time.Second):
			t.Fatal("missing workspace invalidation")
		}
	}
	s.notifyWorkspaceChange("folder")
	s.notifyWorkspaceChange("trash")
	awaitUserEvent(t, first, "state.resync")
	awaitUserEvent(t, second, "state.resync")
	// Private session signals must not go to other accounts.
	s.notifySessionChange("u_user")
	awaitUserEvent(t, first, "session.changed")
	select {
	case ev := <-second:
		t.Fatalf("private event leaked: %+v", ev)
	default:
	}
}

func TestWorkspaceMutationsNotifyOnlyAfterSuccessfulCommit(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	user := domain.User{ID: "u_user"}
	ch, stop := s.SubscribeUserEvents("u_user")
	defer stop()

	// An unauthorized operation must not send a notification to other users.
	if _, err := s.CreateFolder(ctx, user, "folder_root", "denied"); err == nil {
		t.Fatal("unauthorized mutation was accepted")
	}
	select {
	case event := <-ch:
		t.Fatalf("failed transaction generated a notification: %+v", event)
	default:
	}

	folder, err := s.CreateFolder(ctx, admin, "folder_root", "engineering")
	if err != nil {
		t.Fatal(err)
	}
	awaitUserEvent(t, ch, "workspace.changed")
	if _, err = s.CommitUpload(ctx, admin, folder.ID, "model.step", "application/octet-stream", "", strings.NewReader("test-model")); err != nil {
		t.Fatal(err)
	}
	awaitUserEvent(t, ch, "workspace.changed")
	if _, err = s.RenameFolder(ctx, admin, folder.ID, "drawings"); err != nil {
		t.Fatal(err)
	}
	awaitUserEvent(t, ch, "workspace.changed")
}
