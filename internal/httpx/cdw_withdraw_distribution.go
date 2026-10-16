package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
	"strconv"
)

func (h *Handler) cdwDistributionWithdraw(c *gin.Context) {
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
	var input application.CDWDistributionWithdrawalInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWWithdrawDistribution(c.Request.Context(), actor, c.Param("id"), revision, input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("ETag", strconv.Quote("rev-"+strconv.FormatInt(out.PlanRevision, 10)))
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": out})
}
