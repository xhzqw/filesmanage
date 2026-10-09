package application

import "sync"

// UserEvent is deliberately small: the transport exposes only event names,
// never file contents, bearer tokens or sensitive account information.
type UserEvent struct {
	Type string `json:"type"`
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
		select {
		case listener <- event:
		default:
			// If the consumer is still occupied with an older event, retain
			// only the freshest signal so that the client revalidates state.
			select {
			case <-listener:
			default:
			}
			select {
			case listener <- event:
			default:
			}
		}
	}
}

func (s *Service) notifySessionChange(userID string) {
	s.publishUserEvent(userID, UserEvent{Type: "session.changed"})
}
