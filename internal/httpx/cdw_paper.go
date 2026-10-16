package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
	"strconv"
)

func (h *Handler) cdwPaperLedger(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	result, err := h.S.CDWPaperLedger(c.Request.Context(), actor, c.Param("id"))
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": result})
}
func (h *Handler) cdwPaperIssue(c *gin.Context) {
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
	var input application.CDWPaperIssueInput
	if !cdwBind(c, &input) {
		return
	}
	result, err := h.S.CDWPaperIssue(c.Request.Context(), actor, c.Param("id"), rev, input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": result})
}
func (h *Handler) cdwPaperEvent(c *gin.Context) {
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
	var input application.CDWPaperTransitionInput
	if !cdwBind(c, &input) {
		return
	}
	result, err := h.S.CDWPaperRecord(c.Request.Context(), actor, c.Param("id"), rev, input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("ETag", strconv.Quote("rev-"+strconv.FormatInt(result.Revision, 10)))
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": result})
}
