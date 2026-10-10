package httpx

import (
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseAllowlistDefaultsIncludeLoopbackAndLan(t *testing.T) {
	nets := parseAllowlist("")
	if len(nets) != 3 {
		t.Fatalf("default allowlist size = %d, want 3", len(nets))
	}
	found := map[string]bool{}
	for _, n := range nets {
		found[n.String()] = true
	}
	for _, want := range []string{"127.0.0.1/32", "::1/128", "192.168.1.0/24"} {
		if !found[want] {
			t.Fatalf("default allowlist missing %s: %v", want, found)
		}
	}
}

func TestParseAllowlistNormalizesBareIP(t *testing.T) {
	nets := parseAllowlist("192.168.1.22")
	if len(nets) != 1 || nets[0].String() != "192.168.1.22/32" {
		t.Fatalf("bare IP normalization = %v", nets)
	}
}

func TestParseAllowlistRejectsGarbage(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic on malformed CIDR")
		}
	}()
	parseAllowlist("127.0.0.1/32,not-a-cidr")
}

func TestParseAllowlistRejectsEmptyResult(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic when allowlist resolves empty")
		}
	}()
	parseAllowlist(" , ")
}

func TestLanGuardAdmitsConfiguredPeerOnly(t *testing.T) {
	guard := lanGuard(parseAllowlist("127.0.0.1/32,192.168.0.0/16"))
	cases := []struct {
		remote string
		want   int
	}{
		{"127.0.0.1:51000", http.StatusOK},
		{"192.168.7.9:51000", http.StatusOK},
		{"10.0.0.5:51000", http.StatusForbidden},
		{"203.0.113.7:51000", http.StatusForbidden},
		{"garbage", http.StatusForbidden},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(rec)
		c.Request = httptest.NewRequest(http.MethodGet, "/health/live", nil)
		c.Request.RemoteAddr = tc.remote
		guard(c)
		if rec.Code != tc.want {
			t.Fatalf("peer %s: status = %d, want %d", tc.remote, rec.Code, tc.want)
		}
		if tc.want == http.StatusForbidden && !strings.Contains(rec.Body.String(), "E_NETWORK") {
			t.Fatalf("peer %s: body = %q, want E_NETWORK", tc.remote, rec.Body.String())
		}
	}
}

func TestNewEngineEnforcesAllowlistOnRoutes(t *testing.T) {
	t.Setenv("FILESMANAGE_LAN_ALLOW_CIDRS", "127.0.0.1/32,192.168.0.0/16")
	engine := New(application.New(nil, nil), false, t.TempDir())
	cases := []struct {
		remote string
		want   int
	}{
		{"192.168.1.50:40000", http.StatusOK},
		{"172.16.4.4:40000", http.StatusForbidden},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodGet, "/health/live", nil)
		req.RemoteAddr = tc.remote
		rec := httptest.NewRecorder()
		engine.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Fatalf("engine peer %s: status = %d, want %d", tc.remote, rec.Code, tc.want)
		}
	}
}

// TestShareRecipientPayloadKeepsOnlyThePublicFields locks the WF-21 wire shape:
// a picker row carries an id plus a display label and nothing else — in
// particular no login, department, admin or disabled fields.
func TestShareRecipientPayloadKeepsOnlyThePublicFields(t *testing.T) {
	user := shareRecipientPayload("user", application.ShareRecipient{ID: "u_1", Name: "张三"})
	if len(user) != 2 || user["id"] != "u_1" || user["displayName"] != "张三" {
		t.Fatalf("user row must carry exactly id+displayName, got %v", user)
	}
	group := shareRecipientPayload("group", application.ShareRecipient{ID: "g_1", Name: "市场部"})
	if len(group) != 2 || group["id"] != "g_1" || group["name"] != "市场部" {
		t.Fatalf("group row must carry exactly id+name, got %v", group)
	}
}
