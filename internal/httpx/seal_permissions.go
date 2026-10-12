package httpx

import (
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) mySealPermission(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	result, err := h.S.MySealPermission(c.Request.Context(), u)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": result})
}
func (h *Handler) listSealUserPermissions(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	result, err := h.S.SealPermissions(c.Request.Context(), u)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": result})
}
func (h *Handler) updateSealUserPermission(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1024)
	var req struct {
		CanSign  *bool `json:"canSign"`
		CanStamp *bool `json:"canStamp"`
	}
	if c.ShouldBindJSON(&req) != nil || req.CanSign == nil || req.CanStamp == nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	if err := h.S.UpdateSealPermission(c.Request.Context(), u, c.Param("id"), *req.CanSign, *req.CanStamp); err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"userId": c.Param("id"), "canSign": *req.CanSign, "canStamp": *req.CanStamp}})
}
