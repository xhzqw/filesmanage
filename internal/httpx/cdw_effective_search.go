package httpx

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

func (h *Handler) cdwSearchEffective(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	limit := 30
	if str := c.Query("limit"); str != "" {
		n, err := strconv.Atoi(str)
		if err != nil || n < 1 || n > 50 {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": gin.H{"code": "E_INVALID_INPUT"}})
			return
		}
		limit = n
	}
	out, err := h.S.CDWSearchEffective(c.Request.Context(), actor, c.Query("q"), c.Query("cursor"), limit)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": out})
}
