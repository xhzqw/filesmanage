package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAuditRequestIDIsServerGeneratedAndCorrelated(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(requestAuditContext)
	r.POST("/api/safe", func(c *gin.Context) {
		c.String(200, "ok")
	})
	req := httptest.NewRequest(http.MethodPost, "/api/safe", strings.NewReader("{}"))
	req.Header.Set("X-Request-ID", "client-controlled")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	requestID := w.Header().Get("X-Request-ID")
	if w.Code != 200 || requestID == "" || requestID == "client-controlled" || !strings.HasPrefix(requestID, "req-") {
		t.Fatalf("untrusted incoming request id accepted: code=%d id=%s", w.Code, requestID)
	}
	if v := application.NewAuditRequestID(); v == requestID {
		t.Fatal("request IDs must be unique")
	}
}

func TestAuditDenialRouteAllowlist(t *testing.T) {
	for _, tc := range []struct{ method, path, want string }{
		{"POST", "/api/folders/:id/acls", "acl.create"},
		{"DELETE", "/api/acls/:id", "acl.revoke"},
		{"POST", "/api/shares", "share.create"},
		{"DELETE", "/api/shares/:id", "share.revoke"},
		{"POST", "/api/users/:id/password", "user.password_reset"},
		{"POST", "/api/groups/:id/members", "workgroup.member_add"},
		{"GET", "/api/shares", ""},
		{"POST", "/api/login", ""},
	} {
		got, _ := auditedPermissionRoute(tc.method, tc.path)
		if got != tc.want {
			t.Fatalf("route %s %s returned %q, want %q", tc.method, tc.path, got, tc.want)
		}
	}
}
