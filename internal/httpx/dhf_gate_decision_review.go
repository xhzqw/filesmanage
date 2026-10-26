package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) dhfGateDecisionReviewInbox(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	result, err := h.S.DHFGateDecisionReviewInbox(c.Request.Context(), actor)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": result})
}
func (h *Handler) dhfGateDecisionReviewRecommend(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 6000)
	var req application.DHFGateDecisionReviewInput
	if c.ShouldBindJSON(&req) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	result, err := h.S.DHFGateDecisionReviewRecommend(c.Request.Context(), actor, c.Param("reviewId"), req)
	if err != nil {
		respondError(c, err)
		return
	}
	if result.Reason != "" {
		status := http.StatusConflict
		switch result.Reason {
		case "DHF_SCOPE_DENIED":
			status = http.StatusNotFound
		case "DHF_GATE_FORMAL_DECISION_NOT_AUTHORIZED":
			status = http.StatusForbidden
		case "DHF_REAUTH_FAILED", "DHF_REAUTH_RATE_LIMITED":
			status = http.StatusUnauthorized
		case "DHF_GATE_OPINION_REASON_INVALID", "DHF_IDEMPOTENCY_KEY_INVALID":
			status = http.StatusBadRequest
		}
		c.JSON(status, gin.H{"ok": false, "error": gin.H{"code": result.Reason}})
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": result})
}
