package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
)

// File move handlers (COMPLEX-WORKFLOWS §3.2 drafts A and B). The commit
// endpoint authorizes, CAS-guards and audits inside the application
// transaction; the preflight endpoint is a read-only UX check that never
// writes and whose result is not an authorization proof.

func (h *Handler) moveFile(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if u.MustChangePassword {
		c.JSON(403, gin.H{"ok": false, "error": gin.H{"code": "E_PASSWORD_CHANGE_REQUIRED"}})
		return
	}
	var req struct {
		TargetFolderID   string
		ExpectedFolderID string
		IdempotencyKey   string
	}
	if c.ShouldBindJSON(&req) != nil || req.TargetFolderID == "" {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	result, err := h.S.MoveFile(c.Request.Context(), u, c.Param("id"), req.TargetFolderID, req.ExpectedFolderID, req.IdempotencyKey)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{
		"fileId": result.FileID, "fromFolderId": result.FromFolderID,
		"toFolderId": result.ToFolderID, "status": "committed",
	}})
}

func (h *Handler) preflightMoves(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if u.MustChangePassword {
		c.JSON(403, gin.H{"ok": false, "error": gin.H{"code": "E_PASSWORD_CHANGE_REQUIRED"}})
		return
	}
	var req struct {
		Resources []struct {
			Kind string
			ID   string
		}
		TargetFolderID string
		Mode           string
	}
	if c.ShouldBindJSON(&req) != nil || req.TargetFolderID == "" || len(req.Resources) == 0 {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	resources := make([]application.MoveResource, 0, len(req.Resources))
	for _, item := range req.Resources {
		resources = append(resources, application.MoveResource{Kind: item.Kind, ID: item.ID})
	}
	out, err := h.S.PreflightMove(c.Request.Context(), u, resources, req.TargetFolderID, req.Mode)
	if err != nil {
		respondError(c, err)
		return
	}
	conflicts := make([]gin.H, 0, len(out.Conflicts))
	for _, item := range out.Conflicts {
		entry := gin.H{"id": item.ID, "code": item.Code}
		if item.Message != "" {
			entry["message"] = item.Message
		}
		conflicts = append(conflicts, entry)
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{
		"status": out.Status, "candidateRevision": out.CandidateRevision,
		"allowedCount": out.AllowedCount, "conflicts": conflicts,
		"warnings": out.Warnings, "sourceSummary": out.SourceSummary,
		"targetSummary": out.TargetSummary,
	}})
}
