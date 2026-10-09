package httpx

import (
	"errors"
	"filesmanage/internal/application"
	"golang.org/x/net/websocket"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	maxLiveConnections = 128
	liveHeartbeat      = 12 * time.Second
	liveWriteTimeout   = 4 * time.Second
)

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
	events, unsubscribe := h.S.SubscribeUserEvents(user.ID)
	defer unsubscribe()

	websocket.Handler(func(ws *websocket.Conn) {
		h.streamLiveEvents(c.Request, ws, user.ID, token, events)
	}).ServeHTTP(c.Writer, c.Request)
}

func (h *Handler) streamLiveEvents(req *http.Request, ws *websocket.Conn, userID, token string, events <-chan application.UserEvent) {
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
	checkSession := func() bool {
		authenticated, err := h.S.Session(req.Context(), token)
		if errors.Is(err, application.ErrUnauthorized) || (err == nil && authenticated.User.ID != userID) {
			send(map[string]any{"type": "session.revoked"})
			return false
		}
		if err != nil {
			return send(map[string]any{"type": "server.unavailable"})
		}
		if authenticated.User.MustChangePassword {
			send(map[string]any{"type": "session.password_change_required"})
			return false
		}
		h.S.TouchActiveSession(req.Context(), token)
		return true
	}
	if !checkSession() {
		return
	}
	if !send(map[string]any{"type": "connection.ready", "version": 1, "heartbeatSeconds": int(liveHeartbeat / time.Second)}) {
		return
	}

	ticker := time.NewTicker(liveHeartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-req.Context().Done():
			return
		case <-disconnected:
			return
		case event := <-events:
			if !checkSession() {
				return
			}
			if !send(event) {
				return
			}
		case <-ticker.C:
			if !checkSession() {
				return
			}
			if !send(map[string]any{"type": "connection.heartbeat"}) {
				return
			}
		}
	}
}
