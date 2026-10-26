package httpx

import (
	"errors"
	"filesmanage/internal/application"
	"filesmanage/internal/ports"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) dhfStageGateReadiness(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	item, err := h.S.DHFStageGateReadiness(c.Request.Context(), actor, c.Param("submissionId"))
	if errors.Is(err, ports.ErrRowMissing) {
		c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": gin.H{"code": "E_NOT_FOUND"}})
		return
	}
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": item})
}
func (h *Handler) dhfStageGateRequest(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
	var req application.DHFStageGateRequestInput
	if c.ShouldBindJSON(&req) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	result, err := h.S.DHFStageGateRequest(c.Request.Context(), actor, c.Param("submissionId"), req)
	if err != nil {
		respondError(c, err)
		return
	}
	if result.Reason != "" {
		status := http.StatusConflict
		switch result.Reason {
		case "DHF_SCOPE_DENIED":
			status = http.StatusNotFound
		case "DHF_REAUTH_FAILED", "DHF_REAUTH_RATE_LIMITED":
			status = http.StatusUnauthorized
		case "DHF_IDEMPOTENCY_KEY_INVALID":
			status = http.StatusBadRequest
		case "DHF_CONDITIONAL_GATE_NOT_AUTHORIZED":
			status = http.StatusForbidden
		}
		c.JSON(status, gin.H{"ok": false, "error": gin.H{"code": result.Reason}})
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": result})
}
