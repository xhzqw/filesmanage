package httpx

import (
	"context"
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
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

type auditProbeUnit struct {
	ports.UnitOfWork
	tx *auditProbeTx
}

type auditProbeTx struct {
	ports.Tx
	events  []domain.AuditEvent
	commits int
}

func (a auditProbeUnit) Begin(context.Context) (ports.Tx, error) {
	return a.tx, nil
}
func (a *auditProbeTx) RecordAudit(_ context.Context, e domain.AuditEvent) error {
	a.events = append(a.events, e)
	return nil
}
func (a *auditProbeTx) Commit(context.Context) error   { a.commits++; return nil }
func (a *auditProbeTx) Rollback(context.Context) error { return nil }

func TestPermissionDenialMiddlewarePersistsCorrelatedEvent(t *testing.T) {
	gin.SetMode(gin.TestMode)
	probe := &auditProbeTx{}
	h := &Handler{S: application.New(auditProbeUnit{tx: probe}, nil)}
	r := gin.New()
	r.Use(requestAuditContext, h.auditPermissionDenial)
	r.POST("/api/folders/:id/acls", func(c *gin.Context) {
		c.Set("auditActorID", "u_member")
		c.JSON(403, gin.H{"ok": false})
	})
	r.POST("/api/shares", func(c *gin.Context) {
		c.JSON(403, gin.H{"ok": false})
	})
	request := httptest.NewRequest("POST", "/api/folders/folder_root/acls", strings.NewReader("{}"))
	request.Header.Set("X-Request-ID", "injected-client-id")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, request)
	if w.Code != 403 || len(probe.events) != 1 || probe.commits != 1 {
		t.Fatalf("expected committed denial audit, status=%d records=%d commits=%d",
			w.Code, len(probe.events), probe.commits)
	}
	e := probe.events[0]
	if e.RequestID != w.Header().Get("X-Request-ID") || e.RequestID == "injected-client-id" ||
		e.ActorID != "u_member" || e.Outcome != "denied" || e.EventType != "acl.create" ||
		e.TargetID != "folder_root" || e.Details["reason"] != "forbidden" {
		t.Fatalf("denied response and stored event diverged: %+v", e)
	}
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/shares", nil))
	if len(probe.events) != 1 {
		t.Fatal("unidentified request must not create a denial event")
	}
}
