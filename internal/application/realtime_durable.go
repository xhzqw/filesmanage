package application

import (
	"context"
	"filesmanage/internal/domain"
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
