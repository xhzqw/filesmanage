package httpx

import (
	"github.com/gin-gonic/gin"
)

// Lock and approval handlers. Locks are file-level single-writer leases with a
// server-side TTL; approvals carry pending modifications into new versions.

func (h *Handler) acquireLock(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		BaseSeq int
	}
	if c.ShouldBindJSON(&req) != nil || req.BaseSeq <= 0 {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	token, generation, err := h.S.AcquireLock(c.Request.Context(), u, c.Param("id"), req.BaseSeq)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(201, gin.H{"ok": true, "data": gin.H{"lockToken": token, "generation": generation, "expiresInSeconds": 1800}})
}

func (h *Handler) renewLock(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		LockToken string
	}
	if c.ShouldBindJSON(&req) != nil || req.LockToken == "" {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	if err := h.S.RenewLock(c.Request.Context(), u, c.Param("id"), req.LockToken); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"renewed": c.Param("id")}})
}

func (h *Handler) releaseLock(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		LockToken string
	}
	if c.ShouldBindJSON(&req) != nil || req.LockToken == "" {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	if err := h.S.ReleaseLock(c.Request.Context(), u, c.Param("id"), req.LockToken); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"released": c.Param("id")}})
}

func (h *Handler) lockStatus(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	lock, held, err := h.S.LockStatus(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	if !held {
		c.JSON(200, gin.H{"ok": true, "data": gin.H{"locked": false}})
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{
		"locked": true, "ownerName": lock.OwnerName, "baseSeq": lock.BaseSeq,
		"expiresAt": lock.ExpiresAt.UTC().Format("2006-01-02T15:04:05Z"),
	}})
}

func (h *Handler) listApprovals(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	approvals, err := h.S.ListApprovals(c.Request.Context(), u, c.Query("scope"))
	if err != nil {
		respondError(c, err)
		return
	}
	data := make([]gin.H, 0, len(approvals))
	for _, a := range approvals {
		data = append(data, approvalPayload(a))
	}
	c.JSON(200, gin.H{"ok": true, "data": data})
}

func (h *Handler) approveApproval(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		Comment string
	}
	_ = c.ShouldBindJSON(&req)
	result, err := h.S.Approve(c.Request.Context(), u, c.Param("id"), req.Comment)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{
		"fileId": result.FileID, "versionSeq": result.VersionSeq,
		"sha256": result.Sha256, "status": "committed",
	}})
}

func (h *Handler) rejectApproval(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		Comment string
	}
	_ = c.ShouldBindJSON(&req)
	if err := h.S.Reject(c.Request.Context(), u, c.Param("id"), req.Comment); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"rejected": c.Param("id")}})
}

func (h *Handler) cancelApproval(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if err := h.S.CancelApproval(c.Request.Context(), u, c.Param("id")); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"cancelled": c.Param("id")}})
}

func (h *Handler) getApprovalPolicy(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	policy, found, err := h.S.ApprovalPolicy(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	if !found {
		c.JSON(200, gin.H{"ok": true, "data": gin.H{"configured": false}})
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{
		"configured": true, "approverId": policy.ApproverID, "enabled": policy.Enabled,
	}})
}

func (h *Handler) setApprovalPolicy(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		ApproverID string
		Enabled    bool
	}
	if c.ShouldBindJSON(&req) != nil || req.ApproverID == "" {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	if err := h.S.SetApprovalPolicy(c.Request.Context(), u, c.Param("id"), req.ApproverID, req.Enabled); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"configured": true, "approverId": req.ApproverID, "enabled": req.Enabled}})
}

func (h *Handler) clearApprovalPolicy(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if err := h.S.ClearApprovalPolicy(c.Request.Context(), u, c.Param("id")); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"configured": false}})
}
