package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) cdwControlCandidates(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	out, err := h.S.CDWControlCandidates(c.Request.Context(), actor, 100)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"items": out}})
}
func (h *Handler) cdwControlList(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	out, err := h.S.CDWControlList(c.Request.Context(), actor, c.Param("fileId"))
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"items": out}})
}
func (h *Handler) cdwControlGrantRole(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWControlRoleInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWControlGrantRole(c.Request.Context(), actor, input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": out})
}
func (h *Handler) cdwControlPrepare(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWControlPrepareInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWControlPrepare(c.Request.Context(), actor, input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": out})
}
