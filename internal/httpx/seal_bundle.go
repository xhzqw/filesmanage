package httpx

import (
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"io"
	"net/http"
)

func (h *Handler) importSealBundle(c *gin.Context) {
	user, ok := h.auth(c)
	if !ok {
		return
	}
	if !user.IsAdmin {
		respondError(c, domain.ErrForbidden)
		return
	}
	if c.ContentType() != "application/zip" {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 6<<20)
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	data, err := h.S.ImportSealBundle(c.Request.Context(), user, raw)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": data})
}
