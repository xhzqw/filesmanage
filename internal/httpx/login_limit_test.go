package httpx

import (
	"context"
	"errors"
	"filesmanage/internal/application"
	"filesmanage/internal/ports"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLoginLimiterAccountAndIPBudgets(t *testing.T) {
	l := newLoginLimiter()
	now := time.Date(2026, 10, 10, 1, 0, 0, 0, time.UTC)
	l.now = func() time.Time { return now }
	for i := 0; i < loginAccountAttempts; i++ {
		if wait := l.allow("192.168.1.25:3311", "User1"); wait != 0 {
			t.Fatalf("unexpected account throttle at attempt %d: %s", i+1, wait)
		}
	}
	if wait := l.allow("192.168.1.26:3312", " user1 "); wait != loginAccountWindow {
		t.Fatalf("changing IP or case bypassed account limiter: %s", wait)
	}
	if wait := l.allow("192.168.1.25:3313", "user2"); wait != 0 {
		t.Fatalf("separate account should be allowed on same IP: %s", wait)
	}
	now = now.Add(loginAccountWindow + time.Second)
	if wait := l.allow("192.168.1.26:3312", "user1"); wait != 0 {
		t.Fatalf("account budget failed to expire: %s", wait)
	}

	l = newLoginLimiter()
	l.now = func() time.Time { return now }
	for i := 0; i < loginIPAttempts; i++ {
		if wait := l.allow("192.168.1.30:9000", "name-"+string(rune('A'+i))); wait != 0 {
			t.Fatalf("unexpected IP throttle at attempt %d: %s", i+1, wait)
		}
	}
	if wait := l.allow("192.168.1.30:9000", "fresh-name"); wait != loginIPWindow {
		t.Fatalf("IP window not enforced: %s", wait)
	}
	if wait := l.allow("192.168.1.31:9000", "fresh-name"); wait != 0 {
		t.Fatalf("different IP should be admitted: %s", wait)
	}
	now = now.Add(loginIPWindow + time.Second)
	if wait := l.allow("192.168.1.30:9000", "fresh-name"); wait != 0 {
		t.Fatalf("IP budget failed to expire: %s", wait)
	}
}

func TestLoginClientAddrTrustBoundary(t *testing.T) {
	tests := []struct {
		name, remote, proto, forwarded, want string
	}{
		{"direct header spoof ignored", "192.168.1.42:1234", "https", "192.168.1.88", "192.168.1.42:1234"},
		{"direct forwarded-for spoof ignored", "10.144.144.26:1234", "https", "192.168.1.88", "10.144.144.26:1234"},
		{"loopback without tls proxy marker ignored", "127.0.0.1:54321", "http", "192.168.1.88", "127.0.0.1:54321"},
		{"trusted loopback proxy", "127.0.0.1:54321", "https", "192.168.1.88", "192.168.1.88:0"},
		{"trusted vpn proxy", "[::1]:54321", "https", "10.144.144.88", "10.144.144.88:0"},
		{"malformed header ignored", "127.0.0.1:54321", "https", "192.168.1.88, 10.0.0.1", "127.0.0.1:54321"},
		{"empty header ignored", "127.0.0.1:54321", "https", "", "127.0.0.1:54321"},
		{"unspecified header ignored", "127.0.0.1:54321", "https", "0.0.0.0", "127.0.0.1:54321"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/login", nil)
			req.RemoteAddr = tc.remote
			req.Header.Set("X-Forwarded-Proto", tc.proto)
			req.Header.Set("X-Filesmanage-Client-IP", tc.forwarded)
			req.Header.Set("X-Forwarded-For", "203.0.113.200")
			if got := loginClientAddr(req); got != tc.want {
				t.Fatalf("client addr = %q; want %q", got, tc.want)
			}
		})
	}
}

func TestProxyLoginIPBudgetsDoNotMergeAllStaff(t *testing.T) {
	t.Setenv("FILESMANAGE_LAN_ALLOW_CIDRS", "127.0.0.1/32")
	r := New(application.New(logoutTestUOW{beginErr: errors.New("test db unavailable")}, nil), false, t.TempDir())
	send := func(ip, login string) int {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/login",
			strings.NewReader(`{"login":"`+login+`","password":"wrong-test-password"}`))
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Forwarded-Proto", "https")
		req.Header.Set("X-Filesmanage-Client-IP", ip)
		resp := httptest.NewRecorder()
		r.ServeHTTP(resp, req)
		return resp.Code
	}
	for n := 0; n < loginIPAttempts; n++ {
		if got := send("192.168.1.30", fmt.Sprintf("staff-%d", n)); got != http.StatusServiceUnavailable {
			t.Fatalf("attempt %d status=%d; want 503", n+1, got)
		}
	}
	if got := send("192.168.1.31", "another-staff"); got != http.StatusServiceUnavailable {
		t.Fatalf("different HTTPS client incorrectly shared IP bucket: %d", got)
	}
	if got := send("192.168.1.30", "overflow"); got != http.StatusTooManyRequests {
		t.Fatalf("original client IP bucket not enforced: %d", got)
	}
}

func TestLoginLimiterParallelCapacityAndBounds(t *testing.T) {
	l := newLoginLimiter()
	for i := 0; i < maxConcurrentLogins; i++ {
		if !l.acquire() {
			t.Fatal("slot rejected too early")
		}
	}
	if l.acquire() {
		t.Fatal("parallel cap was exceeded")
	}
	l.release()
	if !l.acquire() {
		t.Fatal("released slot cannot be reused")
	}
	if retrySeconds(1100*time.Millisecond) != 2 {
		t.Fatal("retry seconds must round up")
	}
	if wait := l.allow("malformed", "user"); wait <= 0 {
		t.Fatal("invalid socket peer should fail closed")
	}

	// Many account names cannot make the table grow without limit.
	for i := 0; i < loginLimitEntries; i++ {
		key := "x" + string(rune(0x1000+i))
		l.allow("127.0.0.1:4000", key)
		// IP limiter stops CPU work, but new account identities after the first
		// 30 requests are not stored.
	}
	if len(l.byAccount) > loginLimitEntries || len(l.byIP) > loginLimitEntries {
		t.Fatal("unbounded login limiter memory")
	}
}

func TestAuthDependencyFailuresAreNotInvalidCredentials(t *testing.T) {
	t.Setenv("FILESMANAGE_LAN_ALLOW_CIDRS", "127.0.0.1/32")
	r := New(application.New(logoutTestUOW{beginErr: errors.New("db offline")}, nil), false, t.TempDir())
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodPost, "/api/login", `{"login":"admin","password":"valid-length-password"}`},
		{http.MethodGet, "/api/me", ""},
	} {
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		req.RemoteAddr = "127.0.0.1:30000"
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "fm_session", Value: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"})
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "E_DEPENDENCY") {
			t.Fatalf("%s: status=%d body=%s", tc.path, rec.Code, rec.Body.String())
		}
	}
}

func TestLoginRateLimitReturnsRetryAfter(t *testing.T) {
	t.Setenv("FILESMANAGE_LAN_ALLOW_CIDRS", "127.0.0.1/32")
	r := New(application.New(logoutTestUOW{beginErr: errors.New("db offline")}, nil), false, t.TempDir())
	for attempt := 1; attempt <= loginAccountAttempts+1; attempt++ {
		req := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(`{"login":"probe","password":"wrong-password"}`))
		req.RemoteAddr = "127.0.0.1:30001"
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if attempt <= loginAccountAttempts && rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("attempt %d unexpectedly rejected with %d", attempt, rec.Code)
		}
		if attempt == loginAccountAttempts+1 {
			if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") == "" || !strings.Contains(rec.Body.String(), "E_RATE_LIMIT") {
				t.Fatalf("missing 429 and Retry-After: code=%d header=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
			}
		}
	}
}

type logoutTestTx struct {
	ports.Repository
	revokeErr error
}

func (tx logoutTestTx) RevokeSession(context.Context, string) error { return tx.revokeErr }
func (logoutTestTx) Commit(context.Context) error                   { return nil }
func (logoutTestTx) Rollback(context.Context) error                 { return nil }

type logoutTestUOW struct {
	revokeErr error
	beginErr  error
}

func (u logoutTestUOW) Begin(context.Context) (ports.Tx, error) {
	if u.beginErr != nil {
		return nil, u.beginErr
	}
	return logoutTestTx{revokeErr: u.revokeErr}, nil
}

func TestLogoutOnlyClearsCookieAfterConfirmedRevocation(t *testing.T) {
	t.Setenv("FILESMANAGE_LAN_ALLOW_CIDRS", "127.0.0.1/32")
	for _, tc := range []struct {
		name    string
		err     error
		want    int
		cleared bool
	}{
		{"db error", errors.New("connection lost"), http.StatusServiceUnavailable, false},
		{"already revoked", ports.ErrRowMissing, http.StatusOK, true},
		{"normal", nil, http.StatusOK, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := New(application.New(logoutTestUOW{revokeErr: tc.err}, nil), false, t.TempDir())
			req := httptest.NewRequest(http.MethodPost, "/api/logout", nil)
			req.RemoteAddr = "127.0.0.1:50001"
			req.AddCookie(&http.Cookie{Name: "fm_session", Value: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"})
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status=%d want=%d body=%s", rec.Code, tc.want, rec.Body.String())
			}
			setCookie := rec.Header().Get("Set-Cookie")
			if (setCookie != "") != tc.cleared {
				t.Fatalf("unexpected cookie mutation: %q", setCookie)
			}
			if !tc.cleared && !strings.Contains(rec.Body.String(), "E_LOGOUT_FAILED") {
				t.Fatalf("missing error: %s", rec.Body.String())
			}
		})
	}
}
