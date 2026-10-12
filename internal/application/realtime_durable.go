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

func (s *Service) WithDurableEvents(store DurableEventStore) *Service {
	s.durable = store
	return s
}

func (s *Service) DurableEvents() DurableEventStore { return s.durable }

// Cached search and statistics on a different app replica must be dropped as
// soon as that replica observes the shared DB journal. The REST ACL checks
// remain authoritative independently of the event hint.
func (s *Service) InvalidateFromDurableEvent(event domain.RealtimeEvent) {
	if event.Type != "workspace.changed" {
		return
	}
	for _, scope := range event.Scopes {
		switch scope {
		case "file", "folder", "trash", "search", "stats", "permissions", "lifecycle", "organization":
			s.search.invalidate()
			s.stats.invalidate()
			if scope == "permissions" || scope == "organization" {
				s.aclEpoch.Add(1)
			}
			return
		}
	}
}

// WatchDurableCache synchronizes *server-side* caches even when this replica
// currently has no WebSocket clients. Live sockets still own per-user replay;
// this watcher reads only public anonymous invalidations and never holds
// private user events. Start it once per API process.
func (s *Service) WatchDurableCache(ctx context.Context) {
	if s.durable == nil {
		return
	}
	_, cursor, err := s.durable.RealtimeBounds(ctx)
	if err != nil {
		log.Printf("realtime cache observer startup failed: %v", err)
		return
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for {
				events, err := s.durable.RealtimeAfter(ctx, "", cursor, 256)
				if err != nil {
					if ctx.Err() != nil {
						return
					}
					log.Printf("realtime cache observer retry: %v", err)
					break
				}
				for _, event := range events {
					s.InvalidateFromDurableEvent(event)
					cursor = event.ID
				}
				if len(events) < 256 {
					break
				}
			}
		}
	}
}
