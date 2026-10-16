package httpx

import (
	"crypto/sha256"
	"encoding/hex"
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) cdwQMSFormalAudit(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	raw, err := h.S.CDWQMSFormalAudit(c.Request.Context(), actor, c.Param("id"))
	if err != nil {
		cdwError(c, err)
		return
	}
	sum := sha256.Sum256(raw)
	c.Header("Cache-Control", "no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("X-Content-SHA256", hex.EncodeToString(sum[:]))
	c.Header("Content-Disposition", `attachment; filename="CDW-QMS-formal-audit.json"`)
	c.Data(http.StatusOK, "application/json; charset=utf-8", raw)
}
func (h *Handler) cdwQMSFormalNoticeLedger(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	items, err := h.S.CDWQMSFormalNoticeLedger(c.Request.Context(), actor)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"items": items}})
}
func (h *Handler) cdwQMSFormalFollowup(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWQMSFormalFollowupInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWQMSFormalFollowup(c.Request.Context(), actor, c.Param("id"), input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": out})
}
