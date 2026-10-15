package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
	"strconv"
)

func (h *Handler) cdwFormalTemplatePublish(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWFormalTemplateInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWPublishFormalTemplate(c.Request.Context(), actor, input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": out})
}
func (h *Handler) cdwFormalRoleGrant(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWFormalRoleInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWGrantFormalApprover(c.Request.Context(), actor, input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": out})
}
func (h *Handler) cdwFormalCreate(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWFormalStartInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWStartFormalApproval(c.Request.Context(), actor, input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("ETag", strconv.Quote("rev-"+strconv.FormatInt(out.Revision, 10)))
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": out})
}
func (h *Handler) cdwFormalDecide(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	expected, ok := cdwIfMatch(c)
	if !ok {
		return
	}
	var input application.CDWFormalDecisionInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWDecideFormalApproval(c.Request.Context(), actor, c.Param("id"), input, expected, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("ETag", strconv.Quote("rev-"+strconv.FormatInt(out.Revision, 10)))
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": out})
}
func (h *Handler) cdwFormalInbox(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	limit := 50
	if value := c.Query("limit"); value != "" {
		n, err := strconv.Atoi(value)
		if err != nil || n < 1 || n > 100 {
			c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
			return
		}
		limit = n
	}
	items, err := h.S.CDWFormalInbox(c.Request.Context(), actor, limit)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"items": items}})
}
func (h *Handler) cdwFormalReady(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	items, err := h.S.CDWFormalReady(c.Request.Context(), actor, 100)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"items": items}})
}
func (h *Handler) cdwFormalDetail(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	out, err := h.S.CDWFormalDetail(c.Request.Context(), actor, c.Param("id"))
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": out})
}
func (h *Handler) cdwFormalContent(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	reader, _, size, err := h.S.CDWFormalContent(c.Request.Context(), actor, c.Param("id"))
	if err != nil {
		cdwError(c, err)
		return
	}
	defer reader.Close()
	c.Header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	c.Header("Content-Disposition", `attachment; filename="CDW-formal-candidate.docx"`)
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cache-Control", "no-store")
	c.Header("Content-Length", strconv.FormatInt(size, 10))
	c.Status(http.StatusOK)
	_, _ = copyReader(c.Writer, reader)
}
