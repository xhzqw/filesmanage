package httpx

import (
	"github.com/gin-gonic/gin"
	"strconv"
)

func (h *Handler) getApprovalDetail(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	approval, err := h.S.ApprovalDetail(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(200, gin.H{"ok": true, "data": approvalPayload(approval)})
}
func (h *Handler) approvalHistory(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	events, err := h.S.ApprovalHistory(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": events})
}
func (h *Handler) approvalNotifications(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	notes, err := h.S.ApprovalNotifications(c.Request.Context(), u)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": notes})
}
func (h *Handler) readApprovalNotification(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	if err = h.S.ReadApprovalNotification(c.Request.Context(), u, id); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"read": id}})
}
