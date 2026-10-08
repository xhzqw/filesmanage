package httpx

import (
	"encoding/base64"
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// maxUploadBytes caps a single request body; larger uploads are rejected with
// 413 before any staging write.
const maxUploadBytes = 1 << 30

func (h *Handler) uploadFile(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if u.MustChangePassword {
		c.JSON(403, gin.H{"ok": false, "error": gin.H{"code": "E_PASSWORD_CHANGE_REQUIRED"}})
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxUploadBytes)
	header, err := c.FormFile("file")
	if err != nil {
		if isBodyTooLarge(err) {
			c.JSON(413, gin.H{"ok": false, "error": gin.H{"code": "E_TOO_LARGE"}})
			return
		}
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	src, err := header.Open()
	if err != nil {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	defer src.Close()
	result, err := h.S.CommitUpload(c.Request.Context(), u,
		c.PostForm("folderId"), header.Filename, header.Header.Get("Content-Type"),
		c.PostForm("idempotencyKey"), src)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(201, gin.H{"ok": true, "data": gin.H{
		"fileId": result.FileID, "versionSeq": result.VersionSeq, "sha256": result.Sha256,
		"size": result.Size, "name": result.Name, "folderId": result.FolderID, "deduplicated": result.Dedup,
	}})
}

func (h *Handler) listFiles(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if u.MustChangePassword {
		c.JSON(403, gin.H{"ok": false, "error": gin.H{"code": "E_PASSWORD_CHANGE_REQUIRED"}})
		return
	}
	folderID := c.Query("folder")
	if folderID == "" {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	limit := 50
	if raw := c.Query("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 {
			c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
			return
		}
		limit = parsed
	}
	cursor := application.DecodeFileCursor(c.Query("sort"), c.Query("cursor"))
	page, err := h.S.ListFiles(c.Request.Context(), u, folderID, c.Query("sort"), cursor, limit)
	if err != nil {
		respondError(c, err)
		return
	}
	data := make([]gin.H, 0, len(page.Items))
	for _, f := range page.Items {
		data = append(data, filePayload(f))
	}
	payload := gin.H{"items": data, "nextCursor": page.NextCursor}
	c.JSON(200, gin.H{"ok": true, "data": payload})
}

func (h *Handler) fileMeta(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	file, versions, err := h.S.FileMeta(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	versionData := make([]gin.H, 0, len(versions))
	for _, v := range versions {
		versionData = append(versionData, versionPayload(v))
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{
		"file": filePayload(file), "versions": versionData,
	}})
}

func (h *Handler) downloadFile(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	download, closeReader, err := h.S.OpenDownload(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	defer closeReader()
	c.Header("Content-Type", contentTypeOr(download.ContentType))
	c.Header("Content-Length", strconv.FormatInt(download.Size, 10))
	c.Header("X-Content-Sha256", download.Sha256)
	c.Header("Content-Disposition", contentDisposition(download.FileName))
	c.Status(200)
	_, _ = io.Copy(c.Writer, download.Reader)
}

func (h *Handler) previewFile(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	preview, err := h.S.Preview(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	// rawBase64 carries the exact preview prefix bytes so an editor can write
	// them back without any encoding or newline normalisation.
	data := gin.H{
		"fileId": preview.FileID, "name": preview.Name, "contentType": preview.ContentType,
		"size": preview.Size, "sha256": preview.Sha256, "textual": preview.Textual,
		"truncated": preview.Truncated, "content": preview.Content, "byteMeta": preview.ByteMeta,
	}
	if preview.Textual {
		reader, _, _, closeReader, err := h.S.OpenPreviewBytes(c.Request.Context(), u, c.Param("id"))
		if err == nil {
			defer closeReader()
			buf := make([]byte, application.PreviewLimit)
			read := 0
			for read < len(buf) {
				n, readErr := reader.Read(buf[read:])
				read += n
				if readErr != nil {
					break
				}
			}
			data["rawBase64"] = base64.StdEncoding.EncodeToString(buf[:read])
		}
	}
	c.JSON(200, gin.H{"ok": true, "data": data})
}

func (h *Handler) saveFile(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if u.MustChangePassword {
		c.JSON(403, gin.H{"ok": false, "error": gin.H{"code": "E_PASSWORD_CHANGE_REQUIRED"}})
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<20)
	var req struct {
		Data           string
		BaseSeq        int
		LockToken      string
		IdempotencyKey string
	}
	if c.ShouldBindJSON(&req) != nil || req.BaseSeq <= 0 {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	content, err := decodeDataURL(req.Data)
	if err != nil {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	outcome, err := h.S.Save(c.Request.Context(), u, c.Param("id"), content, req.BaseSeq, req.LockToken, req.IdempotencyKey)
	if err != nil {
		respondError(c, err)
		return
	}
	if outcome.Approval != nil {
		c.JSON(202, gin.H{"ok": true, "data": gin.H{
			"status": "pending", "approvalId": outcome.Approval.ID,
			"expectedCurrentSeq": outcome.Approval.BaseSeq, "lockReleased": true,
		}})
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{
		"fileId": outcome.Result.FileID, "versionSeq": outcome.Result.VersionSeq,
		"sha256": outcome.Result.Sha256, "size": outcome.Result.Size, "status": "committed",
	}})
}

func (h *Handler) fileVersions(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	file, versions, err := h.S.FileMeta(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	_ = file
	data := make([]gin.H, 0, len(versions))
	for _, v := range versions {
		data = append(data, versionPayload(v))
	}
	c.JSON(200, gin.H{"ok": true, "data": data})
}

func (h *Handler) rollbackFile(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if u.MustChangePassword {
		c.JSON(403, gin.H{"ok": false, "error": gin.H{"code": "E_PASSWORD_CHANGE_REQUIRED"}})
		return
	}
	var req struct {
		TargetSeq          int
		ExpectedCurrentSeq int
		LockToken          string
		Reason             string
		IdempotencyKey     string
	}
	if c.ShouldBindJSON(&req) != nil || req.TargetSeq <= 0 || req.ExpectedCurrentSeq <= 0 {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	outcome, err := h.S.Rollback(c.Request.Context(), u, c.Param("id"), req.TargetSeq, req.ExpectedCurrentSeq, req.LockToken, req.Reason, req.IdempotencyKey)
	if err != nil {
		respondError(c, err)
		return
	}
	if outcome.Approval != nil {
		c.JSON(202, gin.H{"ok": true, "data": gin.H{
			"status": "pending", "approvalId": outcome.Approval.ID,
			"expectedCurrentSeq": req.ExpectedCurrentSeq, "rollbackTargetSeq": req.TargetSeq,
		}})
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{
		"versionSeq": outcome.Result.VersionSeq, "action": "rollback",
		"rollbackTargetSeq": req.TargetSeq, "rollbackFromSeq": req.ExpectedCurrentSeq,
		"sha256": outcome.Result.Sha256, "status": "committed",
	}})
}

func (h *Handler) deleteFile(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if u.MustChangePassword {
		c.JSON(403, gin.H{"ok": false, "error": gin.H{"code": "E_PASSWORD_CHANGE_REQUIRED"}})
		return
	}
	entry, err := h.S.DeleteFile(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": trashPayload(entry)})
}

// decodeDataURL accepts a raw base64 body or a data: URL prefix.
func decodeDataURL(raw string) ([]byte, error) {
	if i := strings.Index(raw, ","); strings.HasPrefix(raw, "data:") && i > 0 {
		raw = raw[i+1:]
	}
	if raw == "" {
		return nil, nil
	}
	return base64.StdEncoding.DecodeString(raw)
}

// isBodyTooLarge detects the MaxBytesReader trip so the transport reports the
// SPEC 413 instead of a generic 400.
func isBodyTooLarge(err error) bool {
	return err != nil && strings.Contains(err.Error(), "request body too large")
}

// strconvAtoi keeps the numeric query parse next to its only caller.
func strconvAtoi(raw string) (int, error) {
	return strconv.Atoi(raw)
}

// copyReader streams a blob to the response writer.
func copyReader(dst http.ResponseWriter, src interface {
	Read([]byte) (int, error)
}) (int64, error) {
	return io.Copy(dst, src)
}

func contentTypeOr(fallback string) string {
	if fallback == "" {
		return "application/octet-stream"
	}
	return fallback
}

func contentDisposition(name string) string {
	safe := strings.Map(func(r rune) rune {
		if r == '"' || r == '\\' || r < 0x20 {
			return '_'
		}
		return r
	}, name)
	return `attachment; filename="` + safe + `"`
}
