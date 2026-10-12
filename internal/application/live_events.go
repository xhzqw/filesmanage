package application

import "sync"

// UserEvent is deliberately small: the transport exposes only event names,
// never file contents, bearer tokens or sensitive account information.
type UserEvent struct {
	Type   string   `json:"type"`
	Scopes []string `json:"scopes,omitempty"`
}

type userEventHub struct {
	mu        sync.Mutex
	listeners map[string]map[chan UserEvent]struct{}
}

// SubscribeUserEvents returns a bounded notification stream. The caller must
// invoke stop on disconnect; unconsumed updates are coalesced, not queued.
func (s *Service) SubscribeUserEvents(userID string) (<-chan UserEvent, func()) {
	ch := make(chan UserEvent, 1)
	s.live.mu.Lock()
	if s.live.listeners == nil {
		s.live.listeners = make(map[string]map[chan UserEvent]struct{})
	}
	if s.live.listeners[userID] == nil {
		s.live.listeners[userID] = make(map[chan UserEvent]struct{})
	}
	s.live.listeners[userID][ch] = struct{}{}
	s.live.mu.Unlock()
	stop := sync.OnceFunc(func() {
		s.live.mu.Lock()
		defer s.live.mu.Unlock()
		delete(s.live.listeners[userID], ch)
		if len(s.live.listeners[userID]) == 0 {
			delete(s.live.listeners, userID)
		}
	})
	return ch, stop
}

func (s *Service) publishUserEvent(userID string, event UserEvent) {
	if userID == "" {
		return
	}
	s.live.mu.Lock()
	defer s.live.mu.Unlock()
	for listener := range s.live.listeners[userID] {
		enqueueLiveEvent(listener, event)
	}
}

// A slow receiver must never lose a previously requested full resync.
// Repeated hints coalesce while distinct event families escalate to a complete
// authorized REST re-read. Keeping this single-slot queue nonblocking also
// bounds publisher latency independently of browser/network speed.
func enqueueLiveEvent(ch chan UserEvent, event UserEvent) {
	select {
	case ch <- event:
	default:
		// The hub mutex serializes all publishers. The receiver may drain
		// the slot concurrently, but will never see a partially merged event.
		previous := UserEvent{Type: "state.resync"}
		select {
		case previous = <-ch:
		default:
		}
		merged := mergeLiveEvents(previous, event)
		select {
		case ch <- merged:
		default:
		}
	}
}

func mergeLiveEvents(a, b UserEvent) UserEvent {
	if a.Type == "state.resync" || b.Type == "state.resync" {
		return UserEvent{Type: "state.resync"}
	}
	if a.Type == "session.revoked" || b.Type == "session.revoked" {
		return UserEvent{Type: "session.revoked"}
	}
	if a.Type == b.Type {
		if a.Type != "workspace.changed" {
			return a
		}
		seen := make(map[string]bool, len(a.Scopes)+len(b.Scopes))
		merged := UserEvent{Type: "workspace.changed"}
		for _, scope := range append(append([]string{}, a.Scopes...), b.Scopes...) {
			if !seen[scope] {
				seen[scope] = true
				merged.Scopes = append(merged.Scopes, scope)
			}
		}
		if len(merged.Scopes) <= 12 {
			return merged
		}
	}
	return UserEvent{Type: "state.resync"}
}

// Call only after the successful transaction commit. This is a coarse
// single-tenant invalidation: never broadcast filenames, IDs, user identities,
// permissions or file content to accounts that might not have access.
// Every receiver fetches data through its own REST authorization.
func (s *Service) notifyWorkspaceChange(scopes ...string) {
	if len(scopes) == 0 {
		return
	}
	// Only resource/ACL changes invalidate cached queries. Organizational
	// updates and comment-only activity must not flush high-cost aggregations.
	// Real file changes clear the projections before the WebSocket refresh.
	invalidateCache := false
	for _, scope := range scopes {
		switch scope {
		case "file", "folder", "trash", "search", "stats", "permissions", "lifecycle":
			invalidateCache = true
		}
	}
	if invalidateCache {
		s.search.invalidate()
		s.stats.invalidate()
	}
	event := UserEvent{Type: "workspace.changed", Scopes: scopes}
	s.live.mu.Lock()
	defer s.live.mu.Unlock()
	for _, listeners := range s.live.listeners {
		for listener := range listeners {
			enqueueLiveEvent(listener, event)
		}
	}
}

func (s *Service) notifySessionChange(userID string) {
	s.publishUserEvent(userID, UserEvent{Type: "session.changed"})
}
