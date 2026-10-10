package httpx

import (
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) documentAudit(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	limit := 30
	if raw := c.Query("limit"); raw != "" {
		n, err := strconvAtoi(raw)
		if err != nil {
			respondError(c, domain.ErrInvalidInput)
			return
		}
		limit = n
	}
	page, err := h.S.ListDocumentAudit(c.Request.Context(), u, c.Query("cursor"), limit, c.Query("fileId"), c.Query("actorId"), c.Query("event"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": page})
}
