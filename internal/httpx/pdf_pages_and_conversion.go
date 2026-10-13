package httpx

import (
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net/http"
	"strconv"
)

func (h *Handler) pdfPreviewPages(c *gin.Context) {
	user, ok := h.auth(c)
	if !ok {
		return
	}
	count, err := h.S.PDFPreviewPages(c.Request.Context(), user, c.Param("id"), c.Query("sha256"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"pageCount": count}})
}
func (h *Handler) officePreviewPages(c *gin.Context) {
	user, ok := h.auth(c)
	if !ok {
		return
	}
	count, err := h.S.OfficePreviewPages(c.Request.Context(), user, c.Param("id"), c.Query("sha256"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"pageCount": count}})
}
func (h *Handler) officePreviewPage(c *gin.Context) {
	user, ok := h.auth(c)
	if !ok {
		return
	}
	page, err := strconv.Atoi(c.Query("page"))
	if err != nil || page < 1 {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	image, err := h.S.OfficePreviewPage(c.Request.Context(), user, c.Param("id"), c.Query("sha256"), page)
	if err != nil {
		respondError(c, err)
		return
	}
	servePrivateSealPNG(c, image)
}
func (h *Handler) pdfPreviewPage(c *gin.Context) {
	user, ok := h.auth(c)
	if !ok {
		return
	}
	page, err := strconv.Atoi(c.Query("page"))
	if err != nil || page < 1 {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	revision, err := optionalSealRevision(c)
	if err != nil {
		respondError(c, err)
		return
	}
	image, err := h.S.PDFPreviewPageRevision(c.Request.Context(), user, c.Param("id"), c.Query("sha256"), page, revision)
	if err != nil {
		respondError(c, err)
		return
	}
	servePrivateSealPNG(c, image)
}
func (h *Handler) convertDOCXForSigning(c *gin.Context) {
	user, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2048)
	var req struct {
		ExpectedSeq    int    `json:"expectedSeq"`
		ExpectedSha256 string `json:"expectedSha256"`
		IdempotencyKey string `json:"idempotencyKey"`
	}
	if c.ShouldBindJSON(&req) != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	result, err := h.S.ConvertDOCXForSigning(c.Request.Context(), user, c.Param("id"), req.ExpectedSeq, req.ExpectedSha256, req.IdempotencyKey)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": gin.H{
		"fileId": result.FileID, "versionSeq": result.VersionSeq, "sha256": result.Sha256, "name": result.Name,
	}})
}
