package httpx

import (
	"github.com/gin-gonic/gin"
	"strconv"
)

func (h *Handler) listFavoriteNotifications(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	notes, unread, err := h.S.FavoriteNotifications(c.Request.Context(), u)
	if err != nil {
		respondError(c, err)
		return
	}
	items := make([]gin.H, 0, len(notes))
	for _, n := range notes {
		items = append(items, gin.H{
			"id": n.ID, "affectedCount": n.AffectedCount,
			"read": n.Read, "createdAt": n.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"),
		})
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"items": items, "unreadCount": unread}})
}

func (h *Handler) readFavoriteNotification(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	if err = h.S.ReadFavoriteNotification(c.Request.Context(), u, id); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"read": id}})
}
