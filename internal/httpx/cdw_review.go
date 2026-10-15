package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
	"strconv"
)

func (h *Handler) cdwReviewInbox(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	limit := 50
	if raw := c.Query("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
			return
		}
		limit = n
	}
	items, err := h.S.CDWReviewInbox(c.Request.Context(), actor, limit)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"items": items}})
}
func (h *Handler) cdwReviewContent(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	reader, _, size, err := h.S.CDWReviewContent(c.Request.Context(), actor, c.Param("id"))
	if err != nil {
		cdwError(c, err)
		return
	}
	defer reader.Close()
	c.Header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	c.Header("Content-Disposition", "attachment; filename=\"CDW-delivery.docx\"")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cache-Control", "no-store")
	c.Header("Content-Length", strconv.FormatInt(size, 10))
	c.Status(200)
	_, _ = copyReader(c.Writer, reader)
}
func (h *Handler) cdwReviewDetail(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	gate, err := h.S.CDWReviewGate(c.Request.Context(), actor, c.Param("id"))
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("ETag", "\"rev-"+strconv.FormatInt(gate.Revision, 10)+"\"")
	c.JSON(200, gin.H{"ok": true, "data": gate})
}
func (h *Handler) cdwReviewDecide(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	revision, ok := cdwIfMatch(c)
	if !ok {
		return
	}
	var input struct {
		Decision        string `json:"decision"`
		Reason          string `json:"reason"`
		OverrideGrantID string `json:"overrideGrantId,omitempty"`
	}
	if !cdwBind(c, &input) {
		return
	}
	result, err := h.S.CDWDecideReview(c.Request.Context(), actor, c.Param("id"), input.Decision, input.Reason, revision, key, input.OverrideGrantID)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("ETag", "\"rev-"+strconv.FormatInt(result.Revision, 10)+"\"")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": result})
}
func (h *Handler) cdwReviewCandidates(c *gin.Context) {
	user, ok := h.auth(c)
	if !ok {
		return
	}
	candidates, err := h.S.CDWReviewCandidates(c.Request.Context(), user, c.Param("id"))
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"items": candidates}})
}
func (h *Handler) cdwReviewGrant(c *gin.Context) {
	user, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	revision, ok := cdwIfMatch(c)
	if !ok {
		return
	}
	var input struct {
		ActorID string `json:"actorId"`
		Reason  string `json:"reason"`
	}
	if !cdwBind(c, &input) {
		return
	}
	grant, err := h.S.CDWGrantReview(c.Request.Context(), user, c.Param("id"), input.ActorID, input.Reason, revision, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": grant})
}
func (h *Handler) cdwReviewGrants(c *gin.Context) {
	user, ok := h.auth(c)
	if !ok {
		return
	}
	grants, err := h.S.CDWReviewGrants(c.Request.Context(), user, c.Param("id"))
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"items": grants}})
}
func (h *Handler) cdwReviewRevoke(c *gin.Context) {
	user, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input struct{}
	if !cdwBind(c, &input) {
		return
	}
	grant, err := h.S.CDWRevokeReviewGrant(c.Request.Context(), user, c.Param("id"), c.Param("grantId"), key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": grant})
}
func (h *Handler) cdwResumeReturned(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	revision, ok := cdwIfMatch(c)
	if !ok {
		return
	}
	var input struct{}
	if !cdwBind(c, &input) {
		return
	}
	result, err := h.S.CDWResumeReturned(c.Request.Context(), actor, c.Param("id"), revision, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": result})
}

var _ = application.CDWRootTaskInput{}
