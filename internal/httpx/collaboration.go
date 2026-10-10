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

// shareRecipients lists the minimal user/group rows a share creator may pick
// (COMPLEX-WORKFLOWS §9, WF-21). It is deliberately not the admin user
// directory: any authenticated session may call it (creating a share only
// requires the recipient to exist), the payload carries an id plus display
// label only, disabled accounts are excluded and the read is hard-capped.
func (h *Handler) shareRecipients(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	limit := 0
	if raw := c.Query("limit"); raw != "" {
		parsed, err := strconvAtoi(raw)
		if err != nil || parsed < 1 {
			c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
			return
		}
		limit = parsed
	}
	kind := c.Query("kind")
	page, err := h.S.ShareRecipients(c.Request.Context(), u, kind, c.Query("q"), limit)
	if err != nil {
		respondError(c, err)
		return
	}
	data := make([]gin.H, 0, len(page.Items))
	for _, item := range page.Items {
		data = append(data, shareRecipientPayload(kind, item))
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"items": data, "truncated": page.Truncated}})
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
	page, err := h.S.Search(c.Request.Context(), u, filter)
	if err != nil {
		respondError(c, err)
		return
	}
	data := make([]gin.H, 0, len(page.Items))
	for _, f := range page.Items {
		payload := filePayload(f)
		// Snippet is a bounded plain-text window around the match (SPEC §10.3);
		// the client renders it with safe text nodes plus <mark>.
		if f.Snippet != "" {
			payload["snippet"] = f.Snippet
		}
		data = append(data, payload)
	}
	// total is the authorized count for the whole filter and nextCursor is ""
	// on the last page; the client only appends the page the server's cursor
	// names (DESKTOP-INTERACTION §9, WF-30).
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"items": data, "total": page.Total, "nextCursor": page.NextCursor}})
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
	// Flush the BOM and header immediately: the SPEC budget for a streamed
	// export is time-to-first-byte (IO-PERF-03), and a buffered 4 KiB would
	// hold the header hostage until the first batch of rows fills it.
	writer.Flush()
	c.Writer.Flush()
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
		// Opaque keyset cursor from nextCursor; empty means the first page.
		Cursor: c.Query("cursor"),
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
