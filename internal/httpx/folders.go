package httpx

import (
	"filesmanage/internal/application"
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
	entry, folders, err := h.S.DeleteFolder(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{
		"trashId": entry.ID, "folders": folders, "oldName": entry.OldName,
	}})
}

// folderChildren serves GET /api/folders/children: one keyset page of the
// caller's visible children. An absent parentId addresses the visible roots.
func (h *Handler) folderChildren(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	limit, ok := folderPageLimit(c)
	if !ok {
		return
	}
	page, err := h.S.FolderChildren(c.Request.Context(), u, c.Query("parentId"), application.DecodeFolderCursor(c.Query("cursor")), limit)
	if err != nil {
		respondError(c, err)
		return
	}
	items := make([]gin.H, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, folderPageItemPayload(item))
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"items": items, "nextCursor": page.NextCursor}})
}

// searchFolders serves GET /api/folders/search: one keyset page of the caller's
// visible folders whose name matches q, each carrying its visible path.
func (h *Handler) searchFolders(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	limit, ok := folderPageLimit(c)
	if !ok {
		return
	}
	page, err := h.S.SearchFolders(c.Request.Context(), u, c.Query("q"), application.DecodeFolderCursor(c.Query("cursor")), limit)
	if err != nil {
		respondError(c, err)
		return
	}
	items := make([]gin.H, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, folderSearchItemPayload(item))
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"items": items, "nextCursor": page.NextCursor}})
}

// folderPageLimit parses the shared limit query of the paged folder reads: an
// absent limit keeps the application default, a malformed one is E_BAD.
func folderPageLimit(c *gin.Context) (int, bool) {
	raw := c.Query("limit")
	if raw == "" {
		return 0, true
	}
	parsed, err := strconvAtoi(raw)
	if err != nil || parsed < 1 {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return 0, false
	}
	return parsed, true
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
