package application

import (
	"context"
	"filesmanage/internal/domain"
	"sync"
	"testing"
	"time"
)

type replayJournalProbe struct {
	mu     sync.Mutex
	events []domain.RealtimeEvent
	broken bool
}

func (p *replayJournalProbe) RealtimeBounds(context.Context) (int64, int64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.broken {
		return 0, 0, context.DeadlineExceeded
	}
	if len(p.events) == 0 {
		return 0, 0, nil
	}
	return p.events[0].ID, p.events[len(p.events)-1].ID, nil
}
func (p *replayJournalProbe) RealtimeAfter(context.Context, string, int64, int) ([]domain.RealtimeEvent, error) {
	panic("instance cache consumer must never use user-scoped transport replay")
}
func (p *replayJournalProbe) RealtimeFeedAfter(_ context.Context, cursor int64, limit int) ([]domain.RealtimeEvent, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.broken {
		return nil, context.DeadlineExceeded
	}
	var result []domain.RealtimeEvent
	for _, event := range p.events {
		if event.ID > cursor {
			result = append(result, event)
			if len(result) >= limit {
				break
			}
		}
	}
	return result, nil
}
func (p *replayJournalProbe) add(event domain.RealtimeEvent) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.events = append(p.events, event)
}

func untilRealtime(t *testing.T, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !fn() {
		if time.Now().After(deadline) {
			t.Fatal("replica cache did not reconcile durable event")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestReplicaObserverInvalidatesRemoteRevokedSessions(t *testing.T) {
	journal := &replayJournalProbe{}
	journal.add(domain.RealtimeEvent{ID: 1, Type: "workspace.changed", Scopes: []string{"file"}})
	s := New(nil, nil).WithDurableEvents(journal)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.watchDurableCache(ctx, 5*time.Millisecond)
	// Initial successful bound always invalidates caches before following new
	// events; wait for the observer to begin before priming its session cache.
	untilRealtime(t, func() bool { return s.epoch() > 1 })
	now := time.Now()
	const token = "test-user-session"
	s.session.put(token, domain.Authenticated{User: domain.User{ID: "u_user"}, ExpiresAt: now.Add(time.Hour)}, now, s.epoch())
	if _, found := s.session.get(token, now, s.epoch()); !found {
		t.Fatal("session fixture missing")
	}
	journal.add(domain.RealtimeEvent{ID: 2, UserID: "u_user", Type: "session.changed"})
	untilRealtime(t, func() bool {
		_, found := s.session.get(token, now, s.epoch())
		return !found
	})
	// Public file changes must also invalidate a cached dashboard projection
	// on this replica even when there is no connected WebSocket client.
	_, _, revision := s.stats.get("dashboard", now)
	s.stats.put("dashboard", domain.Stats{TotalFiles: 19}, now, revision)
	journal.add(domain.RealtimeEvent{ID: 3, Type: "workspace.changed", Scopes: []string{"file", "stats"}})
	untilRealtime(t, func() bool {
		_, found, _ := s.stats.get("dashboard", now)
		return !found
	})
}

func TestReplicaObserverRecoversFromJournalOutage(t *testing.T) {
	journal := &replayJournalProbe{}
	journal.add(domain.RealtimeEvent{ID: 10, Type: "workspace.changed", Scopes: []string{"file"}})
	s := New(nil, nil).WithDurableEvents(journal)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.watchDurableCache(ctx, 5*time.Millisecond)
	untilRealtime(t, func() bool { return s.epoch() > 1 })
	journal.mu.Lock()
	journal.broken = true
	journal.mu.Unlock()
	// The observer sees a transient DB failure and must stay alive. On
	// recovery its global invalidation prevents stale-session reuse.
	time.Sleep(20 * time.Millisecond)
	now := time.Now()
	s.session.put("stale", domain.Authenticated{User: domain.User{ID: "u_other"}, ExpiresAt: now.Add(time.Hour)}, now, s.epoch())
	journal.mu.Lock()
	journal.broken = false
	journal.mu.Unlock()
	untilRealtime(t, func() bool {
		_, found := s.session.get("stale", now, s.epoch())
		return !found
	})
}
