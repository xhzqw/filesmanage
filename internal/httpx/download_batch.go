package httpx

import (
	"archive/zip"
	"context"
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"fmt"
	"github.com/gin-gonic/gin"
	"io"
	"path/filepath"
	"strings"
	"time"
)

// HEAD performs authorization and limits checks without creating a download
// audit or starting a response body. GET independently repeats the checks.
func (h *Handler) inspectFilesZip(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	ids, err := zipSelection(c)
	if err != nil {
		respondError(c, err)
		return
	}
	total, err := h.S.InspectDownloadBatch(c.Request.Context(), u, ids)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.Header("X-Zip-Files", fmt.Sprint(len(ids)))
	c.Header("X-Zip-Original-Bytes", fmt.Sprint(total))
	c.Status(204)
}
func zipSelection(c *gin.Context) ([]string, error) {
	raw := c.Query("ids")
	if len(raw) > 4096 || raw == "" {
		return nil, fmt.Errorf("%w: ids", domain.ErrInvalidInput)
	}
	return strings.Split(raw, ","), nil
}

// Already-compressed types use STORE: deflate adds CPU without material gains.
func zipEntryMethod(name string) uint16 {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".zip", ".7z", ".gz", ".bz2", ".xz", ".rar", ".jpg", ".jpeg", ".png", ".webp", ".gif",
		".mp3", ".mp4", ".m4a", ".mov", ".mkv", ".pdf", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp":
		return zip.Store
	}
	return zip.Deflate
}

// A single bounded ZIP response prevents browser multi-download restrictions.
// The entire selection is authorized BEFORE status 200 or ZIP bytes are sent.
func (h *Handler) downloadFilesZip(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	ids, err := zipSelection(c)
	if err != nil {
		respondError(c, err)
		return
	}
	files, cleanup, err := h.S.OpenDownloadBatch(c.Request.Context(), u, ids)
	if err != nil {
		respondError(c, err)
		return
	}
	defer cleanup()
	c.Header("Content-Type", "application/zip")
	c.Header("Content-Disposition", contentDisposition("files-"+time.Now().UTC().Format("20060102-150405")+".zip"))
	c.Header("Cache-Control", "private, no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	writer := zip.NewWriter(c.Writer)
	for index, item := range files {
		if c.Request.Context().Err() != nil {
			return
		}
		entry, err := writer.CreateHeader(&zip.FileHeader{Name: application.UniqueZipEntryName(item.FileName, index), Method: zipEntryMethod(item.FileName), Modified: item.ModTime})
		if err != nil {
			return
		}
		_, err = io.CopyN(entry, &cancelReader{ctx: c.Request.Context(), reader: item.Reader}, item.Size)
		if err != nil {
			return
		}
	}
	_ = writer.Close()
}

type cancelReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *cancelReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}
