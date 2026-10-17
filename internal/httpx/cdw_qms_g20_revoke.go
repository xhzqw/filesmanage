package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) cdwQMSEscalationRevoke(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWQMSEscalationReasonInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWQMSEscalationRevoke(c.Request.Context(), actor, c.Param("id"), input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": out})
}
