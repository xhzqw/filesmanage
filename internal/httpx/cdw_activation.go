package httpx

import (
	"github.com/gin-gonic/gin"
	"net/http"
	"strconv"
)

func (h *Handler) cdwActivation(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	revision, ok := cdwIfMatch(c)
	if !ok {
		return
	}
	var input struct{}
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWActivateRelease(c.Request.Context(), actor, c.Param("id"), revision, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("ETag", strconv.Quote("rev-"+strconv.FormatInt(out.Revision, 10)))
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": out})
}
