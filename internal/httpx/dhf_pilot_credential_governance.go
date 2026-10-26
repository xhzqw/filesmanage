package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
)

// Trial credentials are never corporate signing certificates. Authentication
// and delegation are validated by the service against live database grants.
func (h *Handler) dhfPilotCredentialList(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	result, err := h.S.DHFPilotCredentialList(c.Request.Context(), actor)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(200, gin.H{"ok": true, "data": result})
}
func (h *Handler) dhfPilotCredentialRegister(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
	var req application.DHFPilotRegisterCredentialRequest
	if c.ShouldBindJSON(&req) != nil {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	result, err := h.S.DHFPilotRegisterCredential(c.Request.Context(), actor, req)
	h.dhfCredentialMutationResponse(c, result, err)
}
func (h *Handler) dhfPilotCredentialEvent(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
	var req application.DHFPilotCredentialActionRequest
	if c.ShouldBindJSON(&req) != nil {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	result, err := h.S.DHFPilotCredentialTransition(c.Request.Context(), actor, c.Param("id"), req)
	h.dhfCredentialMutationResponse(c, result, err)
}
func (h *Handler) dhfCredentialMutationResponse(c *gin.Context, result application.DHFPilotCredentialMutation, err error) {
	if err != nil {
		respondError(c, err)
		return
	}
	if result.Reason != "" {
		status := http.StatusConflict
		switch result.Reason {
		case "DHF_SCOPE_DENIED":
			status = http.StatusNotFound
		case "DHF_CREDENTIAL_OPERATOR_DENIED":
			status = http.StatusForbidden
		case "DHF_REAUTH_FAILED", "DHF_REAUTH_RATE_LIMITED":
			status = http.StatusUnauthorized
		case "DHF_IDEMPOTENCY_KEY_INVALID", "DHF_CREDENTIAL_INVALID", "DHF_CREDENTIAL_EVENT_INVALID", "DHF_CREDENTIAL_KEY_UNTRUSTED":
			status = http.StatusBadRequest
		}
		c.Header("Cache-Control", "private, no-store")
		c.JSON(status, gin.H{"ok": false, "error": gin.H{"code": result.Reason}})
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(200, gin.H{"ok": true, "data": result})
}
