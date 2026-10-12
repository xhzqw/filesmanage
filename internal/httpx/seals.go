package httpx

import (
	"encoding/base64"
	"errors"
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"fmt"
	"github.com/gin-gonic/gin"
	"net/http"
	"strconv"
)

func (h *Handler) listSealAssets(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	data, err := h.S.SealAssets(c.Request.Context(), u)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(200, gin.H{"ok": true, "data": data})
}
func (h *Handler) createSealAsset(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1600000)
	var req struct {
		Kind      string `json:"kind"`
		Name      string `json:"name"`
		OwnerID   string `json:"ownerId"`
		PNGBase64 string `json:"pngBase64"`
	}
	if c.ShouldBindJSON(&req) != nil || len(req.PNGBase64) > 1450000 {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	data, err := base64.StdEncoding.Strict().DecodeString(req.PNGBase64)
	if err != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	a, err := h.S.CreateSealAsset(c.Request.Context(), u, req.Kind, req.Name, req.OwnerID, data)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(201, gin.H{"ok": true, "data": a})
}
func (h *Handler) manageSealAsset(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2048)
	var req struct {
		Action string `json:"action"`
		UserID string `json:"userId"`
	}
	if c.ShouldBindJSON(&req) != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	if err := h.S.ConfigureSeal(c.Request.Context(), u, c.Param("id"), req.Action, req.UserID); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"updated": c.Param("id")}})
}
func (h *Handler) sealImage(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	data, err := h.S.SealImage(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	servePrivateSealPNG(c, data)
}
func servePrivateSealPNG(c *gin.Context, data []byte) {
	c.Header("Cache-Control", "private, no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cross-Origin-Resource-Policy", "same-origin")
	c.Header("Content-Security-Policy", "default-src 'none'; sandbox")
	c.Data(200, "image/png", data)
}
func (h *Handler) signFileSeal(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
	var input application.SealPlacement
	if c.ShouldBindJSON(&input) != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	mark, err := h.S.SignFile(c.Request.Context(), u, c.Param("id"), input)
	if errors.Is(err, application.ErrInvalidCredentials) {
		c.JSON(http.StatusForbidden, gin.H{"ok": false, "error": gin.H{"code": "E_SIGN_PASSWORD", "message": "签署密码错误"}})
		return
	}
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(201, gin.H{"ok": true, "data": mark})
}
func (h *Handler) usedFileSeals(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	ids, err := h.S.UsedFileSeals(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(200, gin.H{"ok": true, "data": ids})
}
func (h *Handler) listFileSealMarks(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	seq, err := strconv.Atoi(c.Query("version"))
	if err != nil || seq < 1 {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	revision, err := optionalSealRevision(c)
	if err != nil {
		respondError(c, err)
		return
	}
	marks, err := h.S.FileSealsAtRevision(c.Request.Context(), u, c.Param("id"), seq, revision)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(200, gin.H{"ok": true, "data": marks})
}

func (h *Handler) exportFileSealPDF(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	seq, err := strconv.Atoi(c.Query("version"))
	if err != nil || seq < 1 {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	revision, err := optionalSealRevision(c)
	if err != nil {
		respondError(c, err)
		return
	}
	pdf, err := h.S.ExportSignedPDFRevision(c.Request.Context(), u, c.Param("id"), seq, revision, domain.ActionDownload)
	if errors.Is(err, application.ErrPreviewUnsupported) {
		c.JSON(http.StatusUnsupportedMediaType, gin.H{"ok": false, "error": gin.H{"code": "E_PREVIEW_UNSUPPORTED"}})
		return
	}
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Content-Type", "application/pdf")
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", "stamped-version-"+strconv.Itoa(seq)+".pdf"))
	c.Header("Cache-Control", "private, no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("X-Source-Sha256", pdf.SourceSha256)
	c.Data(200, "application/pdf", pdf.Data)
}
func (h *Handler) fileSealPageImage(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	seq, err := strconv.Atoi(c.Query("version"))
	if err != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	page, err := strconv.Atoi(c.Query("page"))
	if err != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	data, err := h.S.SealPagePNG(c.Request.Context(), u, c.Param("id"), seq, page, c.Query("sha256"))
	if errors.Is(err, application.ErrPreviewUnsupported) {
		c.JSON(415, gin.H{"ok": false, "error": gin.H{"code": "E_PREVIEW_UNSUPPORTED"}})
		return
	}
	if err != nil {
		respondError(c, err)
		return
	}
	servePrivateSealPNG(c, data)
}
func (h *Handler) fileSealMarkImage(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	data, err := h.S.FileSealImage(c.Request.Context(), u, c.Param("id"), c.Param("mid"))
	if err != nil {
		respondError(c, err)
		return
	}
	servePrivateSealPNG(c, data)
}
