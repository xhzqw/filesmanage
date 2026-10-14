package httpx

import (
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net/http"
	"time"
)

func (h *Handler) listRoleBindings(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	bindings, err := h.S.ListRoleBindings(c.Request.Context(), u)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": bindings})
}

func (h *Handler) myRoleBindings(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	bindings, err := h.S.MyRoleBindings(c.Request.Context(), u)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": bindings})
}

func (h *Handler) createRoleBinding(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var input struct {
		UserID         string          `json:"userId"`
		Role           string          `json:"role"`
		ScopeID        string          `json:"scopeId"`
		AllowedActions []domain.Action `json:"allowedActions"`
		ExpiresAt      *time.Time      `json:"expiresAt"`
	}
	if c.ShouldBindJSON(&input) != nil || len(input.UserID) > 128 || len(input.ScopeID) > 128 {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	b, err := h.S.CreateRoleBinding(c.Request.Context(), u, application.RoleBindingDraft{
		UserID: input.UserID, Role: input.Role, ScopeID: input.ScopeID,
		AllowedActions: input.AllowedActions, ExpiresAt: input.ExpiresAt,
	})
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": b})
}

func (h *Handler) revokeRoleBinding(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if err := h.S.RevokeRoleBinding(c.Request.Context(), u, c.Param("id")); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"revoked": c.Param("id")}})
}
