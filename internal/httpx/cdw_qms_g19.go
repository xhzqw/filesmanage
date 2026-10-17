package httpx

import (
	"crypto/sha256"
	"encoding/hex"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) cdwQMSFormalAuditSegmented(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	raw, err := h.S.CDWQMSFormalAuditSegmented(c.Request.Context(), actor, c.Param("id"))
	if err != nil {
		cdwError(c, err)
		return
	}
	hash := sha256.Sum256(raw)
	c.Header("Cache-Control", "no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("X-Content-SHA256", hex.EncodeToString(hash[:]))
	c.Header("Content-Disposition", `attachment; filename="CDW-QMS-segmented-audit.json"`)
	c.Data(http.StatusOK, "application/json; charset=utf-8", raw)
}
func (h *Handler) cdwQMSPortfolio(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	page, err := h.S.CDWQMSPortfolio(c.Request.Context(), actor)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": page})
}
