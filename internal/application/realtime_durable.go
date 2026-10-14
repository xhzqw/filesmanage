package application

import (
	"context"
	"filesmanage/internal/domain"
	"log"
	"time"
)

// DurableEventStore is backed by PostgreSQL. Database triggers write the
// invalidations inside each business transaction, not in an after-commit
// in-memory callback. A second API instance reads exactly the same journal.
type DurableEventStore interface {
	RealtimeBounds(context.Context) (int64, int64, error)
	RealtimeAfter(context.Context, string, int64, int) ([]domain.RealtimeEvent, error)
}

// Instance-level reads, unlike end-user replay, contain private recipients
// for revocation-cache invalidation. Never expose them via HTTP/WebSocket.
type DurableInstanceFeed interface {
	RealtimeFeedAfter(context.Context, int64, int) ([]domain.RealtimeEvent, error)
}

func (s *Service) WithDurableEvents(store DurableEventStore) *Service {
	s.durable = store
	return s
}

func (s *Service) DurableEvents() DurableEventStore { return s.durable }

// Cached search and statistics on a different app replica must be dropped as
// soon as that replica observes the shared DB journal. The REST ACL checks
// remain authoritative independently of the event hint.
func (s *Service) InvalidateFromDurableEvent(event domain.RealtimeEvent) {
	if event.Type == "session.changed" && event.UserID != "" {
		// Evict revocations originating on other API replicas; prevent old
		// in-flight DB reads from populating a now-revoked cached session.
		s.aclEpoch.Add(1)
		s.session.dropUser(event.UserID)
		return
	}
	if event.Type != "workspace.changed" {
		return
	}
	cacheAffected := false
	permissionAffected := false
	for _, scope := range event.Scopes {
		switch scope {
		case "file", "folder", "trash", "search", "stats", "permissions", "lifecycle", "organization":
			cacheAffected = true
			if scope == "permissions" || scope == "organization" {
				permissionAffected = true
			}
		}
	}
	// Multiple scopes may be combined into a single durable replay hint.
	// Do NOT exit after the first matching scope: ["file","permissions"] must
	// still invalidate authorization on a different app replica.
	if cacheAffected {
		s.search.invalidate()
		s.stats.invalidate()
	}
	if permissionAffected {
		s.aclEpoch.Add(1)
	}
}

func (s *Service) invalidateAllReplicaCaches() {
	s.aclEpoch.Add(1)
	s.search.invalidate()
	s.stats.invalidate()
	s.session.invalidate()
}

// WatchDurableCache synchronizes *server-side* caches even when this replica
// currently has no WebSocket clients. Live sockets still own per-user replay;
// this watcher reads recipient identities only to invalidate session caches,
// never exposing private events through the browser. Start once per process.
func (s *Service) WatchDurableCache(ctx context.Context) {
	s.watchDurableCache(ctx, 2*time.Second)
}

// PostgreSQL LISTEN/NOTIFY is the low-latency path; polling stays as an
// independent safety net for dropped notifications and listener failures.
func (s *Service) WatchDurableCacheWithWake(ctx context.Context, wake <-chan struct{}) {
	s.watchDurableCacheWithWake(ctx, 2*time.Second, wake)
}

func (s *Service) watchDurableCache(ctx context.Context, interval time.Duration) {
	s.watchDurableCacheWithWake(ctx, interval, nil)
}

func (s *Service) watchDurableCacheWithWake(ctx context.Context, interval time.Duration, wake <-chan struct{}) {
	if s.durable == nil {
		return
	}
	feed, ok := s.durable.(DurableInstanceFeed)
	if !ok {
		log.Printf("realtime cache observer cannot follow private session revocations")
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	var cursor int64
	initialized := false
	broken := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case _, ok := <-wake:
			if !ok {
				wake = nil
				continue
			}
		}
		oldest, newest, err := s.durable.RealtimeBounds(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			broken = true
			log.Printf("realtime cache observer bounds retry: %v", err)
			continue
		}
		if !initialized {
			cursor = newest
			initialized = true
			s.invalidateAllReplicaCaches()
			continue
		}
		if broken || cursor > newest || (oldest > 0 && cursor < oldest-1) {
			// Pruning, a DB restore, or an outage may make events
			// unreplayable. Never keep stale session/authorization caches.
			s.invalidateAllReplicaCaches()
			cursor = newest
			broken = false
			// Every subscriber replays from its own bookmark, never this
			// observer cursor. Wake all after a watcher recovery.
			s.wakeDurableSubscribers(true, nil)
			continue
		}
		publicChanged := false
		privateChanged := make(map[string]struct{})
		for page := 0; page < 8; page++ {
			events, err := feed.RealtimeFeedAfter(ctx, cursor, 256)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				broken = true
				log.Printf("realtime cache observer retry: %v", err)
				break
			}
			for _, event := range events {
				s.InvalidateFromDurableEvent(event)
				if event.UserID == "" {
					publicChanged = true
				} else {
					privateChanged[event.UserID] = struct{}{}
				}
				cursor = event.ID
			}
			if len(events) < 256 {
				break
			}
		}
		s.wakeDurableSubscribers(publicChanged, privateChanged)
	}
}
