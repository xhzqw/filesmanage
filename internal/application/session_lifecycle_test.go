package application

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestCachedSessionNeverExceedsAbsoluteExpiry(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 8, 13, 0, 0, 0, time.UTC)
	s.WithClock(func() time.Time { return now })
	token, _, err := s.Login(ctx, "user1", "long-unit-test-password")
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(24*time.Hour - 2*time.Second)
	if _, err := s.Session(ctx, token); err != nil {
		t.Fatal(err)
	}
	s.session.mu.Lock()
	entry := s.session.entries[token]
	s.session.mu.Unlock()
	if !entry.expireAt.Equal(now.Add(2 * time.Second)) {
		t.Fatalf("cache expiry not capped: %v", entry.expireAt)
	}
	now = now.Add(2 * time.Second)
	if _, err := s.Session(ctx, token); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("expired cached session accepted: %v", err)
	}
}
