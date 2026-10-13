package httpx

import (
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) finderLabels(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	labels, err := h.S.FinderLabels(c.Request.Context(), u)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": labels})
}
func (h *Handler) createFinderLabel(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2048)
	var body struct {
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if c.ShouldBindJSON(&body) != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	label, err := h.S.CreateFinderLabel(c.Request.Context(), u, body.Name, body.Color)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(201, gin.H{"ok": true, "data": label})
}
func (h *Handler) updateFinderLabel(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2048)
	var body struct {
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if c.ShouldBindJSON(&body) != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	label, err := h.S.UpdateFinderLabel(c.Request.Context(), u, c.Param("id"), body.Name, body.Color)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": label})
}
func (h *Handler) deleteFinderLabel(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if err := h.S.RemoveFinderLabel(c.Request.Context(), u, c.Param("id")); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"deleted": true}})
}
func (h *Handler) fileFinderLabels(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	ids, err := h.S.FinderFileLabels(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": ids})
}
func (h *Handler) finderAssignments(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 8192)
	var body struct {
		FileIDs []string `json:"fileIds"`
	}
	if c.ShouldBindJSON(&body) != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	ids, err := h.S.FinderAssignments(c.Request.Context(), u, body.FileIDs)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": ids})
}
func (h *Handler) setFinderFileLabels(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 8192)
	var body struct {
		FileIDs []string `json:"fileIds"`
		Add     bool     `json:"add"`
	}
	if c.ShouldBindJSON(&body) != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	if err := h.S.SetFinderFiles(c.Request.Context(), u, c.Param("id"), body.FileIDs, body.Add); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"updated": len(body.FileIDs)}})
}
func (h *Handler) finderTaggedFiles(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	files, err := h.S.FinderTaggedFiles(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	payload := make([]gin.H, 0, len(files))
	for _, file := range files {
		payload = append(payload, filePayload(file))
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"items": payload}})
}
