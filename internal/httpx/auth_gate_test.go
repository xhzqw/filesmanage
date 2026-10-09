package httpx

import (
	"context"
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Embedding the repository interface keeps this test restricted to the reads
// actually made by session validation and the two protected handlers.
type authGateTestTx struct {
	ports.Repository
	user domain.User
}

func (tx *authGateTestTx) UserBySessionHash(context.Context, string) (domain.Authenticated, error) {
	return domain.Authenticated{User: tx.user, ExpiresAt: time.Now().Add(time.Hour)}, nil
}

func (tx *authGateTestTx) ListUsers(context.Context) ([]domain.User, error) {
	return []domain.User{tx.user}, nil
}

func (tx *authGateTestTx) ListVisibleFolders(context.Context, domain.User) ([]domain.Folder, error) {
	return []domain.Folder{}, nil
}

func (*authGateTestTx) Rollback(context.Context) error { return nil }
func (*authGateTestTx) Commit(context.Context) error   { return nil }

type authGateTestUOW struct {
	user domain.User
}

func (u authGateTestUOW) Begin(context.Context) (ports.Tx, error) {
	return &authGateTestTx{user: u.user}, nil
}

func TestFirstSignInCannotBypassBusinessAPI(t *testing.T) {
	t.Setenv("FILESMANAGE_LAN_ALLOW_CIDRS", "127.0.0.1/32")
	for _, tc := range []struct {
		name string
		path string
		user domain.User
		want int
	}{
		{"pending /me allowed", "/api/me", domain.User{ID: "u_new", MustChangePassword: true}, http.StatusOK},
		{"pending admin cannot list users", "/api/users", domain.User{ID: "u_admin", IsAdmin: true, MustChangePassword: true}, http.StatusForbidden},
		{"pending member cannot list folders", "/api/folders/tree", domain.User{ID: "u_new", MustChangePassword: true}, http.StatusForbidden},
		{"active admin can list users", "/api/users", domain.User{ID: "u_admin", IsAdmin: true}, http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := New(application.New(authGateTestUOW{user: tc.user}, nil), false, t.TempDir())
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			req.RemoteAddr = "127.0.0.1:42100"
			req.AddCookie(&http.Cookie{Name: "fm_session", Value: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"})
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("%s status=%d want=%d body=%s", tc.path, rec.Code, tc.want, rec.Body.String())
			}
		})
	}
}
