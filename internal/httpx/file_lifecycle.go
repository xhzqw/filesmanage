package httpx

import (
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) fileLifecycle(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	value, err := h.S.FileLifecycle(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": value})
}
func (h *Handler) setFileLifecycle(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2048)
	var draft application.LifecycleDraft
	if err := c.ShouldBindJSON(&draft); err != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	value, err := h.S.SetFileLifecycle(c.Request.Context(), u, c.Param("id"), draft)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": value})
}
