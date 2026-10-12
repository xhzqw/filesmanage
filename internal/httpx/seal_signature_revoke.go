package httpx

import (
	"errors"
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) revokeFileMarks(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 8192)
	var req struct {
		VersionSeq       int      `json:"versionSeq"`
		FileSha256       string   `json:"fileSha256"`
		ExpectedRevision int      `json:"expectedRevision"`
		MarkIDs          []string `json:"markIds"`
		Password         string   `json:"password"`
	}
	if c.ShouldBindJSON(&req) != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	data, err := h.S.RevokeFileMarks(c.Request.Context(), actor, c.Param("id"), req.VersionSeq, req.FileSha256, req.ExpectedRevision, req.MarkIDs, req.Password)
	if errors.Is(err, application.ErrInvalidCredentials) {
		c.JSON(http.StatusForbidden, gin.H{"ok": false, "error": gin.H{"code": "E_SIGN_PASSWORD", "message": "删除签章密码错误"}})
		return
	}
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": data})
}
