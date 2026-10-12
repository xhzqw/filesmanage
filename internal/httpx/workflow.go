package httpx

import (
	"github.com/gin-gonic/gin"
	"net/http"
	"strconv"
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

// downloadApprovalDraft serves the exact proposed bytes without modifying
// the published version. A participant must independently have download rights.
func (h *Handler) downloadApprovalDraft(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	download, closeReader, err := h.S.OpenApprovalDraft(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	defer closeReader()
	c.Header("Content-Type", "application/octet-stream")
	c.Header("Content-Disposition", contentDisposition(download.FileName))
	c.Header("X-Content-Sha256", download.Sha256)
	c.Header("Cache-Control", "private, no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	http.ServeContent(c.Writer, c.Request, download.FileName, download.ModTime, download.Reader)
}

// previewApprovalDraft sends a bounded render model; draft bytes remain staged.
func (h *Handler) previewApprovalDraft(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	preview, err := h.S.PreviewApprovalDraft(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	data := gin.H{"fileId": preview.FileID, "name": preview.Name, "contentType": preview.ContentType,
		"size": preview.Size, "sha256": preview.Sha256, "textual": preview.Textual, "truncated": preview.Truncated,
		"content": preview.Content, "byteMeta": preview.ByteMeta, "renderer": preview.Renderer, "mediaType": preview.MediaType}
	if preview.Structured != nil {
		data["structured"] = preview.Structured
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(200, gin.H{"ok": true, "data": data})
}

// previewApprovalDraftMedia rechecks permissions even for Range requests.
func (h *Handler) previewApprovalDraftMedia(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	media, closeReader, err := h.S.OpenInlineApprovalDraft(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	defer closeReader()
	c.Header("Content-Type", media.ContentType)
	c.Header("Content-Disposition", "inline")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cross-Origin-Resource-Policy", "same-origin")
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("Cache-Control", "private, no-store")
	if media.ContentType == "application/pdf" {
		c.Header("Content-Security-Policy", "sandbox")
	}
	http.ServeContent(c.Writer, c.Request, "", media.ModTime, media.Reader)
}

func (h *Handler) compareApprovalDraft(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	result, err := h.S.CompareApprovalDraft(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(200, gin.H{"ok": true, "data": result})
}

func (h *Handler) listApprovals(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if c.Query("limit")!="" {
		limit,err:=strconv.Atoi(c.Query("limit"))
		if err!=nil||limit<1||limit>100 {
			c.JSON(400,gin.H{"ok":false,"error":gin.H{"code":"E_INVALID_INPUT"}})
			return
		}
		page,err:=h.S.ListApprovalsPage(c.Request.Context(),u,c.Query("scope"),c.Query("cursor"),limit)
		if err!=nil{respondError(c,err);return}
		items:=make([]gin.H,0,len(page.Items))
		for _,a:=range page.Items{items=append(items,approvalPayload(a))}
		c.Header("Cache-Control","private, no-store")
		c.JSON(200,gin.H{"ok":true,"data":gin.H{"items":items,"nextCursor":page.NextCursor,"hasMore":page.HasMore,"pendingCount":page.PendingCount}})
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
	status := "committed"
	if result.VersionSeq == 0 {
		status = "pending"
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"fileId": result.FileID, "versionSeq": result.VersionSeq, "sha256": result.Sha256, "status": status}})
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
		"configured": true, "approverId": policy.ApproverID, "approverIds": policy.ApproverChain, "enabled": policy.Enabled,
	}})
}

func (h *Handler) setApprovalPolicy(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		ApproverID  string
		ApproverIDs []string
		Enabled     bool
	}
	if c.ShouldBindJSON(&req) != nil || (req.ApproverID == "" && len(req.ApproverIDs) == 0) {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	chain := req.ApproverIDs
	if len(chain) == 0 {
		chain = []string{req.ApproverID}
	}
	if err := h.S.SetApprovalChainPolicy(c.Request.Context(), u, c.Param("id"), chain, req.Enabled); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"configured": true, "approverId": chain[0], "approverIds": chain, "enabled": req.Enabled}})
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
