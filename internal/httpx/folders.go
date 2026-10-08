package httpx

import (
	"github.com/gin-gonic/gin"
	"net/http"
)

// Folder handlers. Handlers only authenticate, validate transport input and
// serialize; every permission decision lives in the application layer.

func (h *Handler) createFolder(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if u.MustChangePassword {
		c.JSON(403, gin.H{"ok": false, "error": gin.H{"code": "E_PASSWORD_CHANGE_REQUIRED"}})
		return
	}
	var req struct {
		ParentID string
		Name     string
	}
	if c.ShouldBindJSON(&req) != nil || req.ParentID == "" {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	folder, err := h.S.CreateFolder(c.Request.Context(), u, req.ParentID, req.Name)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(201, gin.H{"ok": true, "data": folderPayload(folder.ID, folder.Name, folder.ParentID)})
}

func (h *Handler) renameFolder(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if u.MustChangePassword {
		c.JSON(403, gin.H{"ok": false, "error": gin.H{"code": "E_PASSWORD_CHANGE_REQUIRED"}})
		return
	}
	var req struct {
		Name string
	}
	if c.ShouldBindJSON(&req) != nil {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	folder, err := h.S.RenameFolder(c.Request.Context(), u, c.Param("id"), req.Name)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": folderPayload(folder.ID, folder.Name, folder.ParentID)})
}

func (h *Handler) moveFolder(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if u.MustChangePassword {
		c.JSON(403, gin.H{"ok": false, "error": gin.H{"code": "E_PASSWORD_CHANGE_REQUIRED"}})
		return
	}
	var req struct {
		TargetParentID string
	}
	if c.ShouldBindJSON(&req) != nil || req.TargetParentID == "" {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	folder, err := h.S.MoveFolder(c.Request.Context(), u, c.Param("id"), req.TargetParentID)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": folderPayload(folder.ID, folder.Name, folder.ParentID)})
}

func (h *Handler) deleteFolder(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if u.MustChangePassword {
		c.JSON(403, gin.H{"ok": false, "error": gin.H{"code": "E_PASSWORD_CHANGE_REQUIRED"}})
		return
	}
	entry, folders, err := h.S.DeleteFolder(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{
		"trashId": entry.ID, "folders": folders, "oldName": entry.OldName,
	}})
}

func (h *Handler) listGrants(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	grants, err := h.S.ListGrants(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	data := make([]gin.H, 0, len(grants))
	for _, g := range grants {
		data = append(data, grantPayload(g))
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": data})
}

func (h *Handler) createGrant(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		SubjectKind string
		SubjectID   string
		Actions     []string
		ScopeOnly   bool
		ExpiresAt   *string
	}
	if c.ShouldBindJSON(&req) != nil {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	actions := makeActions(req.Actions)
	grant, err := h.S.CreateGrant(c.Request.Context(), u, c.Param("id"), grantRequest(req.SubjectKind, req.SubjectID, actions, req.ScopeOnly, req.ExpiresAt))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(201, gin.H{"ok": true, "data": grantPayload(grant)})
}

func (h *Handler) revokeGrant(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if err := h.S.RevokeGrant(c.Request.Context(), u, c.Param("id")); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"revoked": c.Param("id")}})
}
