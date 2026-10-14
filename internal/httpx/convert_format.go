package httpx

import (
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) convertFileFormat(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2048)
	var req struct {
		TargetFormat   string `json:"targetFormat"`
		ExpectedSeq    int    `json:"expectedSeq"`
		ExpectedSha256 string `json:"expectedSha256"`
		IdempotencyKey string `json:"idempotencyKey"`
	}
	if c.ShouldBindJSON(&req) != nil || (req.TargetFormat != "pdf" && req.TargetFormat != "docx") {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	result, err := h.S.ConvertFormat(c.Request.Context(), u, c.Param("id"), req.TargetFormat, req.ExpectedSeq, req.ExpectedSha256, req.IdempotencyKey)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": gin.H{"fileId": result.FileID, "folderId": result.FolderID,
		"name": result.Name, "versionSeq": result.VersionSeq, "sha256": result.Sha256}})
}
