package httpx

import (
	"context"
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"log"
	"net/http"
	"time"
)

// One opaque server-owned audit ID per API request; never trust request headers.
func requestAuditContext(c *gin.Context) {
	id := application.NewAuditRequestID()
	c.Header("X-Request-ID", id)
	c.Request = c.Request.WithContext(application.WithAuditRequestID(c.Request.Context(), id))
	c.Next()
}

// Closed route allowlist; never store arbitrary paths or submitted JSON.
func auditedPermissionRoute(method, path string) (event, kind string) {
	switch method + " " + path {
	case "POST /api/folders/:id/acls":
		return "acl.create", "folder"
	case "DELETE /api/acls/:id":
		return "acl.revoke", "grant"
	case "POST /api/shares":
		return "share.create", "share"
	case "DELETE /api/shares/:id":
		return "share.revoke", "share"
	case "POST /api/users":
		return "user.create", "user"
	case "POST /api/users/:id/password":
		return "user.password_reset", "user"
	case "POST /api/users/:id/:state":
		return "user.disable", "user"
	case "POST /api/groups/:id/members":
		return "workgroup.member_add", "workgroup"
	case "DELETE /api/groups/:id/members/:uid":
		return "workgroup.member_remove", "workgroup"
	case "POST /api/roles/bindings":
		return "role.assign", "user"
	case "DELETE /api/roles/bindings/:id":
		return "role.revoke", "role"
	default:
		return "", ""
	}
}

// Persist authenticated denials independently of rolled-back business txs.
func (h *Handler) auditPermissionDenial(c *gin.Context) {
	c.Next()
	if c.Writer.Status() != http.StatusForbidden {
		return
	}
	actor := c.GetString("auditActorID")
	if actor == "" {
		return
	}
	event, kind := auditedPermissionRoute(c.Request.Method, c.FullPath())
	if event == "" {
		return
	}
	if event == "user.disable" && c.Param("state") == "enable" {
		event = "user.enable"
	}
	target := c.Param("id")
	if len(target) > 128 {
		target = ""
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
	defer cancel()
	if err := h.S.RecordPermissionDenial(ctx, actor, event, kind, target); err != nil {
		log.Printf("permission denial audit storage failed for route %s: %v", c.FullPath(), err)
	}
}
