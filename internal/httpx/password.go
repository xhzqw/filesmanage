package httpx

import (
	"errors"
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) changePassword(c *gin.Context) {
	token, err := c.Cookie("fm_session")
	if err != nil {
		c.JSON(401, gin.H{"ok": false, "error": gin.H{"code": "E_AUTH"}})
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 8192)
	var req struct {
		OldPassword string
		NewPassword string
	}
	if c.ShouldBindJSON(&req) != nil {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	u, err := h.S.ChangePassword(c.Request.Context(), token, req.OldPassword, req.NewPassword)
	if err != nil {
		if errors.Is(err, application.ErrPasswordPolicy) {
			c.JSON(422, gin.H{"ok": false, "error": gin.H{"code": "E_PASSWORD_POLICY"}})
			return
		}
		if errors.Is(err, application.ErrInvalidCredentials) {
			c.JSON(401, gin.H{"ok": false, "error": gin.H{"code": "E_INVALID_CREDENTIALS"}})
			return
		}
		c.JSON(409, gin.H{"ok": false, "error": gin.H{"code": "E_PASSWORD_CHANGE_FAILED"}})
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"id": u.ID, "displayName": u.DisplayName, "isAdmin": u.IsAdmin, "mustChangePassword": false}})
}
