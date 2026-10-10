package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"strconv"
	"time"
)

// Trash handlers: list visible entries, restore with optional
// destination/rename, purge (admin only).

func (h *Handler) listTrash(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	// Preserve the legacy array response for existing integration clients.
	// The new workbench always sends paging parameters and receives a page.
	if c.Request.URL.RawQuery == "" {
		entries, err := h.S.ListTrash(c.Request.Context(), u)
		if err != nil {
			respondError(c, err)
			return
		}
		data := make([]gin.H, 0, len(entries))
		for _, entry := range entries {
			if entry.DeletedBy!=u.ID {entry.OldParentTrail=nil}
			data = append(data, trashPayload(entry))
		}
		c.JSON(200, gin.H{"ok": true, "data": data})
		return
	}
	limit, offset := 40, 0
	if raw := c.Query("limit"); raw != "" {
		var err error
		limit, err = strconv.Atoi(raw)
		if err != nil {
			c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
			return
		}
	}
	if raw := c.Query("offset"); raw != "" {
		var err error
		offset, err = strconv.Atoi(raw)
		if err != nil {
			c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
			return
		}
	}
	var from time.Time
	if raw := c.Query("from"); raw != "" {
		var err error
		from, err = time.Parse(time.RFC3339, raw)
		if err != nil {
			c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
			return
		}
	}
	page, err := h.S.PageTrash(c.Request.Context(), u, application.TrashFilters{
		Search: c.Query("search"), Kind: c.Query("kind"), DeletedBy: c.Query("deletedBy"),
		Sort: c.Query("sort"), From: from, Offset: offset, Limit: limit,
	})
	if err != nil {
		respondError(c, err)
		return
	}
	data := make([]gin.H, 0, len(page.Items))
	for _, entry := range page.Items {
		if entry.DeletedBy!=u.ID {entry.OldParentTrail=nil}
		data = append(data, trashPayload(entry))
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"items": data, "hasMore": page.HasMore}})
}

func (h *Handler) restoreTrash(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		DestinationFolderID string
		NewName             string
		ConfirmDestination  bool
	}
	if c.ShouldBindJSON(&req) != nil {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	entry, err := h.S.RestoreFromTrash(c.Request.Context(), u, c.Param("id"), application.RestoreRequest{
		DestinationFolderID:req.DestinationFolderID,NewName:req.NewName,ConfirmDestination:req.ConfirmDestination,
	})
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
