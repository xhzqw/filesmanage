package httpx

import (
	"context"
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"golang.org/x/net/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type replayStore struct{ events []domain.RealtimeEvent }

func (r replayStore) RealtimeBounds(context.Context) (int64, int64, error) {
	if len(r.events) == 0 {
		return 0, 0, nil
	}
	return r.events[0].ID, r.events[len(r.events)-1].ID, nil
}
func (r replayStore) RealtimeAfter(_ context.Context, userID string, cursor int64, limit int) ([]domain.RealtimeEvent, error) {
	var out []domain.RealtimeEvent
	for _, e := range r.events {
		if e.ID > cursor {
			out = append(out, e)
			if len(out) == limit {
				break
			}
		}
	}
	return out, nil
}

func TestWebSocketSameOriginSecurity(t *testing.T) {
	for _, tc := range []struct {
		name, origin, host, peer, proto string
		want                            bool
	}{
		{"HTTP same origin", "http://192.168.1.22:18091", "192.168.1.22:18091", "192.168.1.40:5000", "", true},
		{"HTTPS via Nginx", "https://10.144.144.1:18443", "10.144.144.1:18443", "127.0.0.1:5000", "https", true},
		{"other LAN origin", "http://192.168.1.30:18091", "192.168.1.22:18091", "192.168.1.40:5000", "", false},
		{"missing origin", "", "192.168.1.22:18091", "192.168.1.40:5000", "", false},
		{"null origin", "null", "192.168.1.22:18091", "192.168.1.40:5000", "", false},
		{"scheme downgrade", "http://10.144.144.1:18443", "10.144.144.1:18443", "127.0.0.1:5000", "https", false},
		{"spoofed forwarding from LAN", "https://192.168.1.22:18091", "192.168.1.22:18091", "192.168.1.40:5000", "https", false},
		{"wrong port", "http://192.168.1.22:18092", "192.168.1.22:18091", "192.168.1.40:5000", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://"+tc.host+"/api/events/ws", nil)
			r.RemoteAddr = tc.peer
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("X-Forwarded-Proto", tc.proto)
			if got := websocketSameOrigin(r); got != tc.want {
				t.Fatalf("origin check=%v want %v", got, tc.want)
			}
		})
	}
}

func TestWebSocketHandshakeAndSessionGate(t *testing.T) {
	t.Setenv("FILESMANAGE_LAN_ALLOW_CIDRS", "127.0.0.1/32")
	svc := application.New(authGateTestUOW{user: domain.User{ID: "u_1", Login: "user1"}}, nil)
	server := httptest.NewServer(New(svc, false, t.TempDir()))
	defer server.Close()
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/events/ws"

	request := func(origin string, cookie bool) (*websocket.Conn, error) {
		config, err := websocket.NewConfig(wsURL, origin)
		if err != nil {
			return nil, err
		}
		if cookie {
			config.Header.Set("Cookie", "fm_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
		}
		return websocket.DialConfig(config)
	}
	if conn, err := request("http://attacker.example", true); err == nil {
		conn.Close()
		t.Fatal("cross-origin cookie WebSocket accepted")
	}
	if conn, err := request(server.URL, false); err == nil {
		conn.Close()
		t.Fatal("anonymous WebSocket accepted")
	}
	conn, err := request(server.URL, true)
	if err != nil {
		t.Fatalf("valid WebSocket rejected: %v", err)
	}
	defer conn.Close()
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Type             string `json:"type"`
		Version          int    `json:"version"`
		Resync           bool   `json:"resync"`
		HeartbeatSeconds int    `json:"heartbeatSeconds"`
	}
	if err := websocket.JSON.Receive(conn, &payload); err != nil {
		t.Fatalf("reading greeting: %v", err)
	}
	if payload.Type != "connection.ready" || payload.Version != 2 || !payload.Resync || payload.HeartbeatSeconds <= 0 {
		t.Fatalf("unexpected greeting: %+v", payload)
	}

	resp, err := http.Get(server.URL + "/api/events/ws")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("missing-origin HTTP request returned %d", resp.StatusCode)
	}
}

func TestDurableWebSocketCursorReplayAndGapReconciliation(t *testing.T) {
	t.Setenv("FILESMANAGE_LAN_ALLOW_CIDRS", "127.0.0.1/32")
	events := replayStore{events: []domain.RealtimeEvent{
		{ID: 11, Type: "workspace.changed", Scopes: []string{"file"}},
		{ID: 12, Type: "workspace.changed", Scopes: []string{"folder"}},
		{ID: 13, Type: "session.changed"},
	}}
	svc := application.New(authGateTestUOW{user: domain.User{ID: "u_1", Login: "user1"}}, nil).WithDurableEvents(events)
	server := httptest.NewServer(New(svc, false, t.TempDir()))
	defer server.Close()
	connect := func(cursor string) *websocket.Conn {
		t.Helper()
		url := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/events/ws?cursor=" + cursor
		config, err := websocket.NewConfig(url, server.URL)
		if err != nil {
			t.Fatal(err)
		}
		config.Header.Set("Cookie", "fm_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
		conn, err := websocket.DialConfig(config)
		if err != nil {
			t.Fatal(err)
		}
		if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
			t.Fatal(err)
		}
		return conn
	}
	read := func(c *websocket.Conn) map[string]any {
		t.Helper()
		var payload map[string]any
		if err := websocket.JSON.Receive(c, &payload); err != nil {
			t.Fatal(err)
		}
		return payload
	}
	conn := connect("11")
	first := read(conn)
	if first["version"] != float64(3) || first["resync"] != false || first["cursor"] != "11" {
		t.Fatalf("unexpected durable hello: %+v", first)
	}
	second := read(conn)
	third := read(conn)
	if second["type"] != "workspace.changed" || second["cursor"] != "12" ||
		third["type"] != "session.changed" || third["cursor"] != "13" {
		t.Fatalf("durable replay out of order: %+v %+v", second, third)
	}
	conn.Close()
	// A bookmark older than the retained floor must never pretend that
	// an incomplete replay represents a complete current state.
	conn = connect("8")
	defer conn.Close()
	gap := read(conn)
	if gap["version"] != float64(3) || gap["resync"] != true || gap["cursor"] != "13" {
		t.Fatalf("retention gap not reconciled: %+v", gap)
	}
}
