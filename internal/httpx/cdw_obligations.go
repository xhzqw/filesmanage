package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
	"strconv"
)

func (h *Handler) cdwCompleteObligation(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	rev, ok := cdwIfMatch(c)
	if !ok {
		return
	}
	var body application.CDWObligationCompleteInput
	if !cdwBind(c, &body) {
		return
	}
	out, err := h.S.CDWCompleteObligation(c.Request.Context(), actor, c.Param("id"), body, rev, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("ETag", strconv.Quote("rev-"+strconv.FormatInt(out.Revision, 10)))
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": out})
}
