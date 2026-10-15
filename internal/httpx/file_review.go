package httpx

import (
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net/http"
	"strconv"
)

func (h *Handler) listFileReviewComments(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	version, err := strconv.Atoi(c.Query("version"))
	if err != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	limit := 30
	if raw := c.Query("limit"); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil {
			respondError(c, domain.ErrInvalidInput)
			return
		}
	}
	page, err := h.S.ReviewComments(c.Request.Context(), u, c.Param("id"), version, c.Query("cursor"), limit)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": page})
}
func (h *Handler) createFileReviewComment(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 8192)
	var req struct {
		Version    int    `json:"version"`
		VersionSeq int    `json:"versionSeq"`
		PageNumber *int   `json:"pageNumber"`
		LineNumber *int   `json:"lineNumber"`
		Body       string `json:"body"`
		AssigneeID string `json:"assigneeId"`
	}
	if c.ShouldBindJSON(&req) != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	if req.VersionSeq > 0 {
		req.Version = req.VersionSeq
	}
	out, err := h.S.AddReviewFlowComment(c.Request.Context(), u, c.Param("id"), req.Version, req.PageNumber, req.LineNumber, req.Body, req.AssigneeID)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": out})
}
func (h *Handler) resolveFileReviewComment(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(c.Param("cid"), 10, 64)
	if err != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	if err = h.S.ResolveReviewComment(c.Request.Context(), u, c.Param("id"), id); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"resolved": id}})
}

func (h *Handler) reviewAssignees(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	users, err := h.S.ReviewAssignees(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	out := make([]gin.H, 0, len(users))
	for _, candidate := range users {
		out = append(out, gin.H{"id": candidate.ID, "displayName": candidate.DisplayName,
			"departmentName": candidate.DepartmentName, "role": candidate.Role})
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": out})
}
func (h *Handler) transitionReviewComment(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(c.Param("cid"), 10, 64)
	if err != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 8192)
	var req struct {
		AssigneeID         string `json:"assigneeId"`
		ResolutionNote     string `json:"resolutionNote"`
		ResolvedVersionSeq *int   `json:"resolvedVersionSeq"`
		ApprovalNote       string `json:"approvalNote"`
	}
	if c.ShouldBindJSON(&req) != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	action := c.Param("action")
	note := req.ResolutionNote
	if action == "approve" || action == "reject" {
		note = req.ApprovalNote
	}
	if err = h.S.TransitionReviewComment(c.Request.Context(), u, c.Param("id"), id, action, note, req.ResolvedVersionSeq, req.AssigneeID); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"id": id, "updated": true}})
}
func (h *Handler) reviewNotifications(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	page, err := h.S.ReviewNotices(c.Request.Context(), u)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": page})
}
func (h *Handler) readReviewNotification(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(c.Param("nid"), 10, 64)
	if err != nil {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	if err = h.S.ReadReviewNotice(c.Request.Context(), u, id); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"id": id}})
}
