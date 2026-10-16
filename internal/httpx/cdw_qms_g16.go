package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) cdwQMSLegacyAnomalies(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	items, err := h.S.CDWQMSLegacyAnomalies(c.Request.Context(), actor)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"items": items}})
}
func (h *Handler) cdwQMSLegacyHoldHistory(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	items, err := h.S.CDWQMSLegacyHoldHistory(c.Request.Context(), actor)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"items": items}})
}
func (h *Handler) cdwQMSLegacyHold(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWQMSLegacyHoldInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWQMSHoldLegacy(c.Request.Context(), actor, c.Param("id"), input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": out})
}
func (h *Handler) cdwQMSFormalNotices(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	items, err := h.S.CDWQMSFormalNotices(c.Request.Context(), actor)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"items": items}})
}
func (h *Handler) cdwQMSFormalNoticeRead(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	out, err := h.S.CDWQMSFormalNoticeRead(c.Request.Context(), actor, c.Param("id"), key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": out})
}
