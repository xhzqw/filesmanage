package httpx

import (
	"encoding/csv"
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
	"time"
)

// Collaboration handlers: shares, favorites, search, stats and CSV export.

func (h *Handler) listShares(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	shares, err := h.S.ListShares(c.Request.Context(), u, c.Query("scope"))
	if err != nil {
		respondError(c, err)
		return
	}
	data := make([]gin.H, 0, len(shares))
	for _, s := range shares {
		data = append(data, sharePayload(s))
	}
	c.JSON(200, gin.H{"ok": true, "data": data})
}

func (h *Handler) createShare(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		ResourceKind       string
		ResourceID         string
		RecipientKind      string
		RecipientID        string
		Actions            []string
		IncludeDescendants bool
		ExpiresAt          *string
	}
	if c.ShouldBindJSON(&req) != nil || req.ResourceID == "" || req.RecipientID == "" {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	share, err := h.S.CreateShare(c.Request.Context(), u, shareDraft(req.ResourceKind, req.ResourceID, req.RecipientKind, req.RecipientID, makeActions(req.Actions), req.IncludeDescendants, req.ExpiresAt))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(201, gin.H{"ok": true, "data": sharePayload(share)})
}

func (h *Handler) revokeShare(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if err := h.S.RevokeShare(c.Request.Context(), u, c.Param("id")); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"revoked": c.Param("id")}})
}

func (h *Handler) listFavorites(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	favorites, err := h.S.ListFavorites(c.Request.Context(), u)
	if err != nil {
		respondError(c, err)
		return
	}
	data := make([]gin.H, 0, len(favorites))
	for _, f := range favorites {
		data = append(data, favoritePayload(f))
	}
	c.JSON(200, gin.H{"ok": true, "data": data})
}

func (h *Handler) setFavorite(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	on := c.Request.Method == http.MethodPut
	if err := h.S.SetFavorite(c.Request.Context(), u, c.Param("kind"), c.Param("id"), on); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"id": c.Param("id"), "favorited": on}})
}

func (h *Handler) searchFiles(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	filter, err := parseSearchFilter(c)
	if err != nil {
		respondError(c, err)
		return
	}
	files, total, err := h.S.Search(c.Request.Context(), u, filter)
	if err != nil {
		respondError(c, err)
		return
	}
	data := make([]gin.H, 0, len(files))
	for _, f := range files {
		payload := filePayload(f)
		// Snippet is a bounded plain-text window around the match (SPEC §10.3);
		// the client renders it with safe text nodes plus <mark>.
		if f.Snippet != "" {
			payload["snippet"] = f.Snippet
		}
		data = append(data, payload)
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"items": data, "total": total}})
}

func (h *Handler) statsFiles(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	filter, err := parseSearchFilter(c)
	if err != nil {
		respondError(c, err)
		return
	}
	stats, err := h.S.Stats(c.Request.Context(), u, filter)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": stats})
}

// exportFiles streams the authorized CSV export (SPEC §3.10, PE07). The BOM is
// written first so Excel reads UTF-8 Chinese correctly; rows flush in batches
// so the client receives data while the server is still scanning, and the
// memory profile stays flat regardless of the result size.
func (h *Handler) exportFiles(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	filter, err := parseSearchFilter(c)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", `attachment; filename="files.csv"`)
	c.Status(200)
	if _, err = c.Writer.Write([]byte{0xEF, 0xBB, 0xBF}); err != nil {
		return
	}
	writer := csv.NewWriter(c.Writer)
	_ = writer.Write(exportCSVHeader)
	rows := 0
	_, err = h.S.ExportCSVStream(c.Request.Context(), u, filter, func(fields []string) error {
		if werr := writer.Write(fields); werr != nil {
			return werr
		}
		rows++
		if rows%500 == 0 {
			writer.Flush()
			if ferr := writer.Error(); ferr != nil {
				return ferr
			}
			c.Writer.Flush()
		}
		return nil
	})
	writer.Flush()
	if err != nil {
		// The status line is already committed; record the failure in the audit
		// trail and stop the stream instead of pretending the export succeeded.
		h.S.RecordExportFailure(c.Request.Context(), u, rows, err)
		return
	}
	c.Writer.Flush()
}

// exportCSVHeader follows SPEC §3.10: name, visible path, size, uploader,
// modification time, extension and current version. No blob or storage paths.
var exportCSVHeader = []string{"文件名", "完整可见路径", "大小(字节)", "上传人", "修改时间", "扩展名", "版本号"}

func parseSearchFilter(c *gin.Context) (application.SearchFilter, error) {
	filter := application.SearchFilter{
		FolderID:          c.Query("folder"),
		IncludeDescendant: c.Query("scope") == "descendants",
		Query:             c.Query("q"),
		Uploader:          c.Query("uploader"),
		MimePrefix:        c.Query("type"),
		Sort:              c.Query("sort"),
	}
	if raw := c.Query("limit"); raw != "" {
		parsed, err := strconvAtoi(raw)
		if err != nil {
			return filter, err
		}
		filter.Limit = parsed
	}
	if raw := c.Query("from"); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return filter, err
		}
		filter.From = &parsed
	}
	if raw := c.Query("to"); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return filter, err
		}
		filter.To = &parsed
	}
	return filter, nil
}
