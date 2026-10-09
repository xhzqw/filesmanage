package httpx

import (
	"context"
	"errors"
	"filesmanage/internal/application"
	"filesmanage/internal/ports"
	"github.com/gin-gonic/gin"
	"net/http"
	"time"
)

func (h *Handler) mySessions(c *gin.Context) {
	if _, ok := h.auth(c); !ok {
		return
	}
	token, _ := c.Cookie("fm_session")
	ctx, cancel := context.WithTimeout(c.Request.Context(), 4*time.Second)
	defer cancel()
	items, err := h.S.ListMySessions(ctx, token)
	if err != nil {
		writeSessionError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": items})
}
func (h *Handler) mySessionActivity(c *gin.Context) {
	if _, ok := h.auth(c); !ok {
		return
	}
	token, _ := c.Cookie("fm_session")
	ctx, cancel := context.WithTimeout(c.Request.Context(), 4*time.Second)
	defer cancel()
	items, err := h.S.ListMyAuthActivity(ctx, token)
	if err != nil {
		writeSessionError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": items})
}
func (h *Handler) revokeOwnSession(c *gin.Context) {
	if _, ok := h.auth(c); !ok {
		return
	}
	token, _ := c.Cookie("fm_session")
	ctx, cancel := context.WithTimeout(c.Request.Context(), 4*time.Second)
	defer cancel()
	if err := h.S.RevokeMySession(ctx, token, c.Param("id")); err != nil {
		writeSessionError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"revoked": true}})
}
func (h *Handler) revokeOtherSessions(c *gin.Context) {
	if _, ok := h.auth(c); !ok {
		return
	}
	token, _ := c.Cookie("fm_session")
	ctx, cancel := context.WithTimeout(c.Request.Context(), 4*time.Second)
	defer cancel()
	count, err := h.S.RevokeOtherMySessions(ctx, token)
	if err != nil {
		writeSessionError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"revoked": count}})
}
func writeSessionError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, application.ErrUnauthorized):
		c.JSON(401, gin.H{"ok": false, "error": gin.H{"code": "E_AUTH"}})
	case errors.Is(err, ports.ErrRowMissing):
		// Nonexistent and cross-user session IDs are indistinguishable.
		c.JSON(404, gin.H{"ok": false, "error": gin.H{"code": "E_NOT_FOUND"}})
	case errors.Is(err, application.ErrInvalidInput):
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
	default:
		c.JSON(503, gin.H{"ok": false, "error": gin.H{"code": "E_DEPENDENCY"}})
	}
}
