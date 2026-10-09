package httpx

import (
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net/http"
	"strconv"
)

// explainPermissions deliberately uses POST: subject IDs remain out of proxy
// URL/query logs. No authorization decision is made in the HTTP layer.
func (h *Handler) explainPermissions(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if u.MustChangePassword {
		c.JSON(http.StatusForbidden, gin.H{"ok": false, "error": gin.H{"code": "E_PASSWORD_CHANGE_REQUIRED"}})
		return
	}
	var input struct {
		SubjectKind string `json:"subjectKind"`
		SubjectID   string `json:"subjectId"`
		FolderID    string `json:"folderId"`
	}
	if c.ShouldBindJSON(&input) != nil || input.SubjectKind != "user" || input.SubjectID == "" || input.FolderID == "" ||
		len(input.SubjectID) > 128 || len(input.FolderID) > 128 {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	result, err := h.S.ExplainFolderPermissions(c.Request.Context(), u, input.SubjectID, input.FolderID)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": result})
}

func (h *Handler) permissionAudit(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if u.MustChangePassword {
		c.JSON(http.StatusForbidden, gin.H{"ok": false, "error": gin.H{"code": "E_PASSWORD_CHANGE_REQUIRED"}})
		return
	}
	limit := 30
	if raw := c.Query("limit"); raw != "" {
		var err error
		limit, err = strconv.Atoi(raw)
		if err != nil {
			respondError(c, domain.ErrInvalidInput)
			return
		}
	}
	page, err := h.S.ListPermissionAudit(c.Request.Context(), u, c.Query("cursor"), limit)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": page})
}
