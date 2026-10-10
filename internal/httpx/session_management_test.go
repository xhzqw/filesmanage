package httpx

import (
	"context"
	"encoding/json"
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type sessionAccessTx struct {
	ports.Repository
	user domain.User
}

func (t sessionAccessTx) UserBySessionHash(context.Context, string) (domain.Authenticated, error) {
	return domain.Authenticated{User: t.user, ExpiresAt: time.Now().Add(time.Hour)}, nil
}
func (t sessionAccessTx) SetSessionMetadata(context.Context, string, string, string) error {
	return nil
}
func (t sessionAccessTx) TouchSession(context.Context, string) error           { return nil }
func (t sessionAccessTx) SessionOwner(context.Context, string) (string, error) { return t.user.ID, nil }
func (t sessionAccessTx) ListOwnSessions(_ context.Context, id string) ([]ports.SessionRow, error) {
	return []ports.SessionRow{{ID: strings.Repeat("a", 24), Device: "Test", CreatedAt: time.Now(), LastSeenAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour)}}, nil
}
func (t sessionAccessTx) RevokeOwnSession(context.Context, string, string, string) (bool, error) {
	return false, nil
}
func (t sessionAccessTx) RevokeOtherSessions(context.Context, string, string) (int64, error) {
	return 0, nil
}
func (t sessionAccessTx) ListOwnAuthActivity(context.Context, string) ([]ports.AuthActivity, error) {
	return []ports.AuthActivity{}, nil
}
func (t sessionAccessTx) RecordAudit(context.Context, domain.AuditEvent) error { return nil }
func (t sessionAccessTx) Commit(context.Context) error                         { return nil }
func (t sessionAccessTx) Rollback(context.Context) error                       { return nil }

type sessionAccessUOW struct{ user domain.User }

func (u sessionAccessUOW) Begin(context.Context) (ports.Tx, error) {
	return sessionAccessTx{user: u.user}, nil
}

func TestOwnSessionsAuthAndNoEnumeration(t *testing.T) {
	t.Setenv("FILESMANAGE_LAN_ALLOW_CIDRS", "127.0.0.1/32")
	token := strings.Repeat("A", 43)
	for _, tc := range []struct {
		name, method, path string
		pending, cookie    bool
		want               int
	}{
		{"anonymous list", "GET", "/api/me/sessions", false, false, 401},
		{"legacy credential flag still allows list", "GET", "/api/me/sessions", true, true, 200},
		{"list active", "GET", "/api/me/sessions", false, true, 200},
		{"list audit", "GET", "/api/me/auth-activity", false, true, 200},
		{"unknown session", "DELETE", "/api/me/sessions/" + strings.Repeat("f", 24), false, true, 404},
		{"wrongly formatted ID", "DELETE", "/api/me/sessions/abcdef", false, true, 404},
		{"revoke others", "DELETE", "/api/me/sessions/others", false, true, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := New(application.New(sessionAccessUOW{user: domain.User{ID: "u_test", MustChangePassword: tc.pending}}, nil), false, t.TempDir())
			req := httptest.NewRequest(tc.method, tc.path, nil)
			req.RemoteAddr = "127.0.0.1:10240"
			if tc.cookie {
				req.AddCookie(&http.Cookie{Name: "fm_session", Value: token})
			}
			rec := httptest.NewRecorder()
			srv.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status %d want %d: %s", rec.Code, tc.want, rec.Body.String())
			}
			if tc.name == "list active" {
				var data struct {
					Ok   bool
					Data []ports.SessionRow
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &data); err != nil || !data.Ok || len(data.Data) != 1 {
					t.Fatalf("invalid JSON: %v %s", err, rec.Body.String())
				}
			}
		})
	}
}
