package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
	"strconv"
)

func (h *Handler) dhfTemplate(c *gin.Context) {
	if _, ok := h.auth(c); !ok {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": application.DHFOutline()})
}
func (h *Handler) dhfProjects(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	out, err := h.S.DHFProjects(c.Request.Context(), actor)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": out})
}
func (h *Handler) dhfCreate(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var in application.DHFCreateInput
	if !cdwBind(c, &in) {
		return
	}
	out, err := h.S.DHFCreate(c.Request.Context(), actor, in, key)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": out})
}
func (h *Handler) dhfDetail(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	out, err := h.S.DHFDetail(c.Request.Context(), actor, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": out})
}
func (h *Handler) dhfItemAction(c *gin.Context) {
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
	line, err := strconv.Atoi(c.Param("line"))
	if err != nil || line < 2 {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	var in application.DHFItemAction
	if !cdwBind(c, &in) {
		return
	}
	out, err := h.S.DHFActItem(c.Request.Context(), actor, c.Param("id"), line, rev, in, key)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": out})
}
func (h *Handler) dhfAcceptStage(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	stage, err := strconv.Atoi(c.Param("stage"))
	if err != nil || stage < 1 || stage > 9 {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	var in application.DHFStageAction
	if !cdwBind(c, &in) {
		return
	}
	out, err := h.S.DHFAcceptStage(c.Request.Context(), actor, c.Param("id"), stage, in, key)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": out})
}

func (h *Handler) dhfFileVersions(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	out, err := h.S.DHFFileVersions(c.Request.Context(), actor, c.Param("fileId"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": out})
}
