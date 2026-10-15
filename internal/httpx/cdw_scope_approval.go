package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
	"strconv"
)

func (h *Handler) cdwDistributionScopeGrant(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWDistributionScopeRoleInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWGrantDistributionScopeApprover(c.Request.Context(), actor, input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": out})
}
func (h *Handler) cdwDistributionScopeApprove(c *gin.Context) {
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
	out, err := h.S.CDWApproveDistributionScope(c.Request.Context(), actor, c.Param("id"), revision, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("ETag", strconv.Quote("rev-"+strconv.FormatInt(out.Revision, 10)))
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": out})
}
func (h *Handler) cdwDistributionScopeInbox(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	list, err := h.S.CDWDistributionScopeInbox(c.Request.Context(), actor, 100)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"items": list}})
}
