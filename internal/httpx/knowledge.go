package httpx

import (
	"encoding/json"
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) knowledgeList(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	pages, e := h.S.KnowledgeList(c.Request.Context(), u)
	if e != nil {
		respondError(c, e)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": pages})
}
func (h *Handler) knowledgeGet(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	p, e := h.S.KnowledgeGet(c.Request.Context(), u, c.Param("id"))
	if e != nil {
		respondError(c, e)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": p})
}
func (h *Handler) knowledgeHistory(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	items, e := h.S.KnowledgeHistory(c.Request.Context(), u, c.Param("id"))
	if e != nil {
		respondError(c, e)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": items})
}
func (h *Handler) knowledgeCreate(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		Title    string `json:"title"`
		ParentID string `json:"parentId"`
		FolderID string `json:"folderId"`
	}
	if c.ShouldBindJSON(&req) != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	p, e := h.S.KnowledgeCreate(c.Request.Context(), u, req.Title, req.ParentID, req.FolderID)
	if e != nil {
		respondError(c, e)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": p})
}
func (h *Handler) knowledgeUpdate(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		Title    string          `json:"title"`
		Blocks   json.RawMessage `json:"blocks"`
		Revision int             `json:"revision"`
	}
	if c.ShouldBindJSON(&req) != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	p, e := h.S.KnowledgeUpdate(c.Request.Context(), u, c.Param("id"), req.Title, req.Blocks, req.Revision)
	if e != nil {
		respondError(c, e)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": p})
}
func (h *Handler) knowledgeDelete(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		Revision int `json:"revision"`
	}
	if c.ShouldBindJSON(&req) != nil || req.Revision < 1 {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	if e := h.S.KnowledgeDelete(c.Request.Context(), u, c.Param("id"), req.Revision); e != nil {
		respondError(c, e)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"archived": true}})
}
func (h *Handler) knowledgeFolderHome(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	id, e := h.S.KnowledgeFolderHome(c.Request.Context(), u, c.Param("folderId"))
	if e != nil {
		respondError(c, e)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"pageId": id, "automatic": false}})
}
func (h *Handler) knowledgeLinkFolderHome(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		PageID string `json:"pageId"`
	}
	if c.ShouldBindJSON(&req) != nil || req.PageID == "" {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	if e := h.S.KnowledgeLinkFolderHome(c.Request.Context(), u, c.Param("folderId"), req.PageID); e != nil {
		respondError(c, e)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"pageId": req.PageID, "automatic": false}})
}
func (h *Handler) knowledgeUnlinkFolderHome(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if e := h.S.KnowledgeUnlinkFolderHome(c.Request.Context(), u, c.Param("folderId")); e != nil {
		respondError(c, e)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"pageId": ""}})
}
func (h *Handler) knowledgeFileReference(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	fileID := c.Param("fileId")
	pageID := c.Param("id")
	if fileID == "" || pageID == "" {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	if e := h.S.KnowledgeFileRef(c.Request.Context(), u, pageID, fileID, c.Request.Method == "DELETE"); e != nil {
		respondError(c, e)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"fileId": fileID}})
}
func (h *Handler) knowledgeBacklinks(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	list, e := h.S.KnowledgeBacklinks(c.Request.Context(), u, c.Param("fileId"))
	if e != nil {
		respondError(c, e)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": list})
}
func (h *Handler) knowledgePageLinks(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	list, e := h.S.KnowledgePageLinks(c.Request.Context(), u, c.Param("id"))
	if e != nil {
		respondError(c, e)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": list})
}
func (h *Handler) knowledgePageRelation(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if e := h.S.KnowledgePageRelation(c.Request.Context(), u, c.Param("id"), c.Param("targetId"), c.Request.Method == "DELETE"); e != nil {
		respondError(c, e)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"targetId": c.Param("targetId")}})
}
