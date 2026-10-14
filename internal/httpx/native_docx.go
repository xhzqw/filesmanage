package httpx

import (
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) nativeDOCXContent(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	result, err := h.S.NativeDOCXContent(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": result})
}

func (h *Handler) saveNativeDOCX(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20)
	var req struct {
		BaseSeq        int      `json:"baseSeq"`
		LockToken      string   `json:"lockToken"`
		IdempotencyKey string   `json:"idempotencyKey"`
		Paragraphs     []string `json:"paragraphs"`
	}
	if c.ShouldBindJSON(&req) != nil || req.BaseSeq < 1 || len(req.Paragraphs) == 0 || len(req.IdempotencyKey) < 12 {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	outcome, err := h.S.SaveNativeDOCX(c.Request.Context(), u, c.Param("id"), req.BaseSeq, req.LockToken, req.IdempotencyKey, req.Paragraphs)
	if err != nil {
		respondError(c, err)
		return
	}
	if outcome.Approval != nil {
		c.JSON(http.StatusAccepted, gin.H{"ok": true, "data": gin.H{"status": "pending", "versionSeq": 0}})
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": gin.H{"status": "committed", "versionSeq": outcome.Result.VersionSeq}})
}
