package httpx

import (
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"io"
	"net/http"
	"strconv"
)

func (h *Handler) startResumable(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 8192)
	var req struct {
		FolderID       string `json:"folderId"`
		Name           string `json:"name"`
		ContentType    string `json:"contentType"`
		Size           int64  `json:"size"`
		SHA256         string `json:"sha256"`
		IdempotencyKey string `json:"idempotencyKey"`
	}
	if c.ShouldBindJSON(&req) != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	status, err := h.S.StartResumableUpload(c.Request.Context(), u, req.FolderID, req.Name, req.ContentType, req.IdempotencyKey, req.SHA256, req.Size)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": status})
}
func (h *Handler) resumableStatus(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	result, err := h.S.ResumableStatus(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": result})
}
func (h *Handler) resumableChunk(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	offset, err := strconv.ParseInt(c.GetHeader("X-Chunk-Offset"), 10, 64)
	if err != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	data, err := io.ReadAll(io.LimitReader(c.Request.Body, application.MaxResumableChunk+1))
	if err != nil {
		respondError(c, err)
		return
	}
	if len(data) > application.MaxResumableChunk {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"ok": false, "error": gin.H{"code": "E_TOO_LARGE"}})
		return
	}
	result, err := h.S.AppendResumableChunk(c.Request.Context(), u, c.Param("id"), offset, data, c.GetHeader("X-Chunk-Sha256"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": result})
}
func (h *Handler) finishResumable(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	result, err := h.S.CompleteResumableUpload(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{
		"fileId": result.FileID, "versionSeq": result.VersionSeq, "sha256": result.Sha256,
		"size": result.Size, "name": result.Name, "folderId": result.FolderID, "deduplicated": result.Dedup,
	}})
}
func (h *Handler) cancelResumable(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if err := h.S.CancelResumableUpload(c.Request.Context(), u, c.Param("id")); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"cancelled": c.Param("id")}})
}
