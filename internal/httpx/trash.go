package httpx

import (
	"github.com/gin-gonic/gin"
)

// Trash handlers: list visible entries, restore with optional
// destination/rename, purge (admin only).

func (h *Handler) listTrash(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	entries, err := h.S.ListTrash(c.Request.Context(), u)
	if err != nil {
		respondError(c, err)
		return
	}
	data := make([]gin.H, 0, len(entries))
	for _, entry := range entries {
		data = append(data, trashPayload(entry))
	}
	c.JSON(200, gin.H{"ok": true, "data": data})
}

func (h *Handler) restoreTrash(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		DestinationFolderID string
		NewName             string
	}
	if c.ShouldBindJSON(&req) != nil {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	entry, err := h.S.RestoreFromTrash(c.Request.Context(), u, c.Param("id"), restoreRequest(req.DestinationFolderID, req.NewName))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": trashPayload(entry)})
}

func (h *Handler) purgeTrash(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if err := h.S.PurgeTrashEntry(c.Request.Context(), u, c.Param("id")); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"purged": c.Param("id")}})
}
