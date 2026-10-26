package httpx

import "github.com/gin-gonic/gin"

// Assigned Gate reviewer only. A verification result never authorizes a
// new signature, Stage acceptance, CDW release or controlled distribution.
func (h *Handler) dhfPilotGateVerification(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	result, err := h.S.DHFPilotGateVerification(c.Request.Context(), actor, c.Param("submissionId"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(200, gin.H{"ok": true, "data": result})
}
