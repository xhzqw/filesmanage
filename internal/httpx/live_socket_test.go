package httpx

import (
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"golang.org/x/net/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

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
