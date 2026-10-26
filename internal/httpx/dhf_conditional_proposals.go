package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) dhfConditionalPlanCatalog(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	result, err := h.S.DHFConditionalProposalCatalog(c.Request.Context(), actor)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": result})
}
func (h *Handler) dhfConditionalPlanFile(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 12000)
	var req application.DHFConditionalProposalInput
	if c.ShouldBindJSON(&req) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	result, err := h.S.DHFConditionalProposalFile(c.Request.Context(), actor, req)
	if err != nil {
		respondError(c, err)
		return
	}
	respondDHFConditionalOutcome(c, result)
}
func (h *Handler) dhfConditionalPlanWithdraw(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4000)
	var req application.DHFConditionalWithdrawalInput
	if c.ShouldBindJSON(&req) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	result, err := h.S.DHFConditionalProposalWithdraw(c.Request.Context(), actor, c.Param("id"), req)
	if err != nil {
		respondError(c, err)
		return
	}
	respondDHFConditionalOutcome(c, result)
}
func respondDHFConditionalOutcome(c *gin.Context, result application.DHFConditionalProposalOutcome) {
	if result.Reason != "" {
		status := http.StatusConflict
		switch result.Reason {
		case "DHF_SCOPE_DENIED":
			status = http.StatusNotFound
		case "DHF_REAUTH_FAILED":
			status = http.StatusUnauthorized
		case "DHF_CONDITION_NOT_ELIGIBLE":
			status = http.StatusForbidden
		case "DHF_CONDITION_REASON_INVALID", "DHF_CONDITION_DEADLINE_INVALID",
			"DHF_IDEMPOTENCY_KEY_INVALID", "DHF_CONDITION_OBLIGATION_INVALID":
			status = http.StatusBadRequest
		}
		c.JSON(status, gin.H{"ok": false, "error": gin.H{"code": result.Reason}})
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": result})
}
