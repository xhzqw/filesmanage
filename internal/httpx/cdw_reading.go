package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
	"strconv"
)

func (h *Handler) cdwReadingEligible(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	items, err := h.S.CDWReadingEligible(c.Request.Context(), actor, c.Param("id"))
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"items": items}})
}
func (h *Handler) cdwReadingRosterCreate(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWReadingRosterInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWCreateReadingRoster(c.Request.Context(), actor, c.Param("id"), input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": out})
}
func (h *Handler) cdwReadingRosterDetail(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	out, err := h.S.CDWReadingRoster(c.Request.Context(), actor, c.Param("id"))
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": out})
}
func (h *Handler) cdwReadingInbox(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	items, err := h.S.CDWReadingInbox(c.Request.Context(), actor, 100)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"items": items}})
}
func (h *Handler) cdwReadingConfirm(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWReadingConfirmationInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWConfirmReading(c.Request.Context(), actor, c.Param("id"), input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": out})
}
func (h *Handler) cdwReadingContent(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	reader, _, size, err := h.S.CDWReadingContent(c.Request.Context(), actor, c.Param("id"))
	if err != nil {
		cdwError(c, err)
		return
	}
	defer reader.Close()
	c.Header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	c.Header("Content-Disposition", `attachment; filename="CDW-controlled-distribution.docx"`)
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cache-Control", "no-store")
	c.Header("Content-Length", strconv.FormatInt(size, 10))
	c.Status(http.StatusOK)
	bytesSent, copyErr := copyReader(c.Writer, reader)
	// Persist opened evidence only if the complete immutable artifact was
	// successfully streamed to the authenticated user's connection.
	if cdwFullTransferComplete(bytesSent, size, copyErr, c.Request.Context().Err()) {
		if err := h.S.CDWReadingContentDelivered(c.Request.Context(), actor, c.Param("id")); err != nil {
			_ = c.Error(err)
		}
	}
}

func cdwFullTransferComplete(sent, expected int64, copyErr, contextErr error) bool {
	return expected > 0 && sent == expected && copyErr == nil && contextErr == nil
}
