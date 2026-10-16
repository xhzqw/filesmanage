package httpx

import (
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) cdwQMSFormalLineage(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	chain, err := h.S.CDWQMSFormalLineage(c.Request.Context(), actor, c.Param("id"))
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": chain})
}
