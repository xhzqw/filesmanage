package httpx

import (
	"errors"
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"golang.org/x/net/websocket"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	maxLiveConnections = 128
	liveHeartbeat      = 12 * time.Second
	liveWriteTimeout   = 4 * time.Second
	liveDurablePoll    = 2 * time.Second
	liveReplayBatch    = 128
)

// Coalesce contiguous known workspace invalidations before WebSocket writes.
// The persisted journal still contains every original transaction; only the
// subscriber's stateless replay *frames* are compacted. Keep other event
// types in order so session revocations and approval notifications are never
// suppressed, and carry the highest included cursor for at-least-once replay.
func compactLiveBatch(batch []domain.RealtimeEvent) []domain.RealtimeEvent {
	out := make([]domain.RealtimeEvent, 0, len(batch))
	for _, event := range batch {
		if event.Type == "workspace.changed" && knownLiveScopes(event.Scopes) && len(out) > 0 {
			last := &out[len(out)-1]
			if last.Type == "workspace.changed" && knownLiveScopes(last.Scopes) {
				last.ID = event.ID
				for _, scope := range event.Scopes {
					found := false
					for _, present := range last.Scopes {
						if present == scope {
							found = true
							break
						}
					}
					if !found {
						last.Scopes = append(last.Scopes, scope)
					}
				}
				continue
			}
		}
		// Copy the scopes: compaction must never mutate the input backing array,
		// which can be shared by a fake store or retained between replays.
		event.Scopes = append([]string(nil), event.Scopes...)
		out = append(out, event)
	}
	return out
}

func knownLiveScopes(scopes []string) bool {
	if len(scopes) == 0 {
		return false
	}
	for _, scope := range scopes {
		switch scope {
		case "file", "folder", "trash", "permissions", "collaboration", "organization",
			"search", "stats", "review", "lifecycle", "approval-policy", "presets":
		default:
			return false
		}
	}
	return true
}

// websocketSameOrigin is separate from checkOrigin: WebSocket handshakes use
// GET and carry ambient cookies. Missing, null, cross-scheme and cross-host
// origins must never be allowed. Forwarded scheme is trusted ONLY from the
// loopback Nginx peer; direct LAN clients cannot spoof it.
func websocketSameOrigin(r *http.Request) bool {
	raw := r.Header.Get("Origin")
	if raw == "" || raw == "null" {
		return false
	}
	origin, err := url.Parse(raw)
	if err != nil || origin.Host == "" || origin.Opaque != "" || origin.User != nil ||
		origin.RawQuery != "" || origin.Fragment != "" || origin.Path != "" {
		return false
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	} else if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		if peer := net.ParseIP(host); peer != nil && peer.IsLoopback() &&
			r.Header.Get("X-Forwarded-Proto") == "https" {
			scheme = "https"
		}
	}
	return strings.EqualFold(origin.Scheme, scheme) && strings.EqualFold(origin.Host, r.Host)
}

func headerHasToken(value, wanted string) bool {
	for _, word := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(word), wanted) {
			return true
		}
	}
	return false
}

func (h *Handler) websocketEvents(c *gin.Context) {
	if !websocketSameOrigin(c.Request) {
		c.JSON(http.StatusForbidden, gin.H{"ok": false, "error": gin.H{"code": "E_ORIGIN"}})
		return
	}
	if !strings.EqualFold(c.GetHeader("Upgrade"), "websocket") ||
		!headerHasToken(c.GetHeader("Connection"), "upgrade") {
		c.Header("Upgrade", "websocket")
		c.JSON(http.StatusUpgradeRequired, gin.H{"ok": false, "error": gin.H{"code": "E_UPGRADE_REQUIRED"}})
		return
	}
	user, ok := h.auth(c)
	if !ok {
		return
	}
	select {
	case h.LiveSlots <- struct{}{}:
		defer func() { <-h.LiveSlots }()
	default:
		c.JSON(http.StatusServiceUnavailable, gin.H{"ok": false, "error": gin.H{"code": "E_LIVE_CAPACITY"}})
		return
	}
	token, _ := c.Cookie("fm_session")
	// The cursor is not a credential: reject malformed/unbounded values rather
	// than interpreting them as tokens or permitting arbitrary SQL ranges.
	cursor := int64(0)
	if raw := c.Query("cursor"); raw != "" && len(raw) <= 19 {
		if parsed, err := strconv.ParseInt(raw, 10, 64); err == nil && parsed >= 0 {
			cursor = parsed
		}
	}
	events, unsubscribe := h.S.SubscribeUserEvents(user.ID)
	defer unsubscribe()

	websocket.Handler(func(ws *websocket.Conn) {
		h.streamLiveEvents(c.Request, ws, user.ID, token, cursor, events)
	}).ServeHTTP(c.Writer, c.Request)
}

func (h *Handler) streamLiveEvents(req *http.Request, ws *websocket.Conn, userID, token string, resumeCursor int64, events <-chan application.UserEvent) {
	ws.MaxPayloadBytes = 1024
	defer ws.Close()

	disconnected := make(chan struct{})
	go func() {
		defer close(disconnected)
		var ignored []byte
		// Outbound-only protocol. Reading keeps the connection teardown fast
		// and prevents a client from occupying a slot after closing its tab.
		for {
			if err := websocket.Message.Receive(ws, &ignored); err != nil {
				return
			}
			if len(ignored) != 0 {
				return
			}
		}
	}()

	send := func(message any) bool {
		if err := ws.SetWriteDeadline(time.Now().Add(liveWriteTimeout)); err != nil {
			return false
		}
		return websocket.JSON.Send(ws, message) == nil
	}
	var lastTouched time.Time
	checkSession := func() bool {
		authenticated, err := h.S.Session(req.Context(), token)
		if errors.Is(err, application.ErrUnauthorized) || (err == nil && authenticated.User.ID != userID) {
			send(map[string]any{"type": "session.revoked"})
			return false
		}
		if err != nil {
			// A temporary inability to validate credentials is not proof
			// the session is revoked, but it must not allow delivery either.
			send(map[string]any{"type": "server.unavailable"})
			return false
		}
		// TouchSession is a SQL write transaction even when its 60-second
		// predicate rejects the update. Never execute it per replay frame.
		if time.Since(lastTouched) >= 45*time.Second {
			lastTouched = time.Now()
			h.S.TouchActiveSession(req.Context(), token)
		}
		return true
	}
	if !checkSession() {
		return
	}
	store := h.S.DurableEvents()
	// Tests with an in-memory repository retain the legacy v2 stream. The
	// production constructor requires a PostgreSQL-backed durable store.
	if store == nil {
		if !send(map[string]any{"type": "connection.ready", "version": 2, "resync": true, "heartbeatSeconds": int(liveHeartbeat / time.Second)}) {
			return
		}
	} else {
		oldest, newest, err := store.RealtimeBounds(req.Context())
		if err != nil {
			send(map[string]any{"type": "server.unavailable"})
			return
		}
		// If the client has no bookmark, it must reconcile all visible state;
		// replaying the full lifetime of the journal would be unnecessary.
		// Expired, invalid or future bookmarks likewise require a full resync.
		resync := resumeCursor == 0 || replayCursorExpired(resumeCursor, oldest, newest)
		if resync {
			resumeCursor = newest
		}
		if !send(map[string]any{"type": "connection.ready", "version": 3,
			"resync": resync, "cursor": strconv.FormatInt(resumeCursor, 10),
			"heartbeatSeconds": int(liveHeartbeat / time.Second)}) {
			return
		}
	}

	ticker := time.NewTicker(liveHeartbeat)
	defer ticker.Stop()
	poll := time.NewTicker(liveDurablePoll)
	defer poll.Stop()
	// Database is the single source of truth, including events produced by
	// other API replicas. Local notifications only wake this reader promptly.
	// Cursors advance after successful sends, never before.
	replay := func() bool {
		// Bound one wake-up to 512 events. A huge backlog must not starve
		// heartbeat and disconnect handling while the user catches up.
		for page := 0; page < 4; page++ {
			batch, err := store.RealtimeAfter(req.Context(), userID, resumeCursor, liveReplayBatch)
			if err != nil {
				return send(map[string]any{"type": "server.unavailable"})
			}
			for _, event := range compactLiveBatch(batch) {
				if !checkSession() {
					return false
				}
				if !send(map[string]any{"type": event.Type, "scopes": event.Scopes,
					"cursor": strconv.FormatInt(event.ID, 10)}) {
					return false
				}
				resumeCursor = event.ID
				h.S.InvalidateFromDurableEvent(event)
			}
			if len(batch) < liveReplayBatch {
				return true
			}
		}
		return true
	}
	if store != nil && !replay() {
		return
	}
	for {
		select {
		case <-req.Context().Done():
			return
		case <-disconnected:
			return
		case event := <-events:
			if store != nil {
				if !replay() {
					return
				}
			} else {
				if !checkSession() || !send(event) {
					return
				}
			}
		case <-poll.C:
			if store != nil && !replay() {
				return
			}
		case <-ticker.C:
			if !checkSession() {
				return
			}
			if store != nil {
				// Retention can advance while a socket stays connected. Its
				// cursor may fall outside the journal before the next replay.
				oldest, newest, err := store.RealtimeBounds(req.Context())
				if err != nil {
					if !send(map[string]any{"type": "server.unavailable"}) {
						return
					}
					continue
				}
				if replayCursorExpired(resumeCursor, oldest, newest) {
					if !send(map[string]any{"type": "state.resync", "cursor": strconv.FormatInt(newest, 10)}) {
						return
					}
					resumeCursor = newest
				}
			}
			if !send(map[string]any{"type": "connection.heartbeat"}) {
				return
			}
		}
	}
}

// Journal gap detection is based on a *durable* retention watermark in
// RealtimeBounds, not only the oldest row that happens to remain.
func replayCursorExpired(cursor, oldest, newest int64) bool {
	return cursor > newest || (oldest > 0 && cursor < oldest-1)
}
