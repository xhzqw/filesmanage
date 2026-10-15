package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"log"
	"net/http"
	"strconv"
	"strings"
)

func (h *Handler) cdwCreateBranch(c *gin.Context) {
	user, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		TaskID string `json:"taskId"`
	}
	if !cdwBind(c, &req) {
		return
	}
	branch, err := h.S.CDWCreateBranch(c.Request.Context(), user, req.TaskID)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("ETag", "\"rev-"+strconv.FormatInt(branch.Revision, 10)+"\"")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": branch})
}
func (h *Handler) cdwOpenBranchOffice(c *gin.Context) {
	user, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct{}
	if !cdwBind(c, &req) {
		return
	}
	view, err := h.S.CDWOpenBranchOffice(c.Request.Context(), user, c.Param("id"))
	if err != nil {
		cdwError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": view})
}
func (h *Handler) cdwRequestBranchSave(c *gin.Context) {
	user, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		SessionID string `json:"sessionId"`
	}
	if !cdwBind(c, &req) {
		return
	}
	result, err := h.S.CDWRequestBranchSave(c.Request.Context(), user, c.Param("id"), req.SessionID)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.JSON(http.StatusAccepted, gin.H{"ok": true, "data": result})
}
func (h *Handler) cdwReadBranchSave(c *gin.Context) {
	user, ok := h.auth(c)
	if !ok {
		return
	}
	result, err := h.S.CDWBranchSaveStatus(c.Request.Context(), user, c.Param("id"), c.Param("rid"))
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": result})
}
func (h *Handler) cdwFreezeBranch(c *gin.Context) {
	user, ok := h.auth(c)
	if !ok {
		return
	}
	expected, ok := cdwIfMatch(c)
	if !ok {
		return
	}
	var req struct {
		RequestID        string `json:"requestId"`
		BranchRevisionID string `json:"branchRevisionId"`
	}
	if !cdwBind(c, &req) {
		return
	}
	result, err := h.S.CDWFreezeBranch(c.Request.Context(), user, c.Param("id"), req.RequestID, req.BranchRevisionID, expected)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("ETag", "\"rev-"+strconv.FormatInt(result.Revision, 10)+"\"")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": result})
}
func (h *Handler) cdwBranchSource(c *gin.Context) {
	reader, name, size, release, err := h.S.CDWBranchSource(c.Request.Context(), c.Param("token"))
	if err != nil {
		respondError(c, err)
		return
	}
	defer release()
	c.Header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	c.Header("Content-Length", strconv.FormatInt(size, 10))
	c.Header("Content-Disposition", contentDisposition(name))
	c.Status(http.StatusOK)
	_, _ = copyReader(c.Writer, reader)
}
func (h *Handler) cdwBranchCallback(c *gin.Context) {
	auth := strings.TrimSpace(strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer"))
	var body application.EditorCallbackPayload
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(200, gin.H{"error": 1})
		return
	}
	code, err := h.S.CDWHandleBranchCallback(c.Request.Context(), auth, body)
	if err != nil {
		log.Printf("CDW branch office callback rejected status=%d errorClass=%T", body.Status, err)
		c.JSON(200, gin.H{"error": codeOr(code, err)})
		return
	}
	c.JSON(200, gin.H{"error": 0})
}
