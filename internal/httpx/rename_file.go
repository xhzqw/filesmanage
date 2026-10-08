package httpx

import (
	"github.com/gin-gonic/gin"
)

func (h *Handler) renameFile(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if u.MustChangePassword {
		c.JSON(403, gin.H{"ok": false, "error": gin.H{"code": "E_PASSWORD_CHANGE_REQUIRED"}})
		return
	}
	var req struct {
		Name string
	}
	if c.ShouldBindJSON(&req) != nil {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	file, err := h.S.RenameFile(c.Request.Context(), u, c.Param("id"), req.Name)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": filePayload(file)})
}
