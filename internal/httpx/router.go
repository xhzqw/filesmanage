package httpx

import (
	"context"
	"errors"
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Handler struct {
	S             *application.Service
	SecureCookies bool
	Dist          string
	LoginLimit    *loginLimiter
	LiveSlots     chan struct{}
}

// parseAllowlist fails closed: an unreadable or malformed allowlist must stop startup
// rather than silently widen or narrow network exposure.
func parseAllowlist(spec string) []*net.IPNet {
	if strings.TrimSpace(spec) == "" {
		spec = "127.0.0.1/32,::1/128,203.0.113.0/24"
	}
	var nets []*net.IPNet
	for _, item := range strings.Split(spec, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if !strings.Contains(item, "/") {
			item = item + "/32"
		}
		_, network, err := net.ParseCIDR(item)
		if err != nil {
			panic("invalid FILESMANAGE_LAN_ALLOW_CIDRS entry: " + item)
		}
		nets = append(nets, network)
	}
	if len(nets) == 0 {
		panic("FILESMANAGE_LAN_ALLOW_CIDRS resolved to an empty allowlist")
	}
	return nets
}

// lanGuard admits only socket peers inside the configured CIDRs. It reads the kernel
// peer address (never forwarded headers) so a client cannot spoof its way past it.
func lanGuard(nets []*net.IPNet) gin.HandlerFunc {
	return func(c *gin.Context) {
		host, _, err := net.SplitHostPort(c.Request.RemoteAddr)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"ok": false, "error": gin.H{"code": "E_NETWORK"}})
			return
		}
		ip := net.ParseIP(host)
		if ip == nil {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"ok": false, "error": gin.H{"code": "E_NETWORK"}})
			return
		}
		for _, network := range nets {
			if network.Contains(ip) {
				c.Next()
				return
			}
		}
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"ok": false, "error": gin.H{"code": "E_NETWORK"}})
	}
}

func New(s *application.Service, secure bool, dist string) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	h := &Handler{S: s, SecureCookies: secure, Dist: dist, LoginLimit: newLoginLimiter(), LiveSlots: make(chan struct{}, maxLiveConnections)}
	r := gin.New()
	r.Use(gin.Recovery(), lanGuard(parseAllowlist(os.Getenv("FILESMANAGE_LAN_ALLOW_CIDRS"))), gin.Logger())
	r.GET("/health/live", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
	r.GET("/health/ready", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
		defer cancel()
		if s.Ready(ctx) != nil {
			c.JSON(503, gin.H{"ok": false})
			return
		}
		c.JSON(200, gin.H{"ok": true})
	})
	api := r.Group("/api")
	api.Use(requestAuditContext, checkOrigin, h.auditPermissionDenial)
	api.POST("/login", h.login)
	api.POST("/logout", h.logout)
	api.POST("/me/password", h.changePassword)
	api.GET("/me", h.me)
	api.GET("/me/sessions", h.mySessions)
	api.GET("/me/auth-activity", h.mySessionActivity)
	api.DELETE("/me/sessions/others", h.revokeOtherSessions)
	api.DELETE("/me/sessions/:id", h.revokeOwnSession)
	api.GET("/events/ws", h.websocketEvents)
	api.GET("/folders/tree", h.folders)
	api.GET("/labels", h.finderLabels)
	api.POST("/labels/assignments", h.finderAssignments)
	api.POST("/labels", h.createFinderLabel)
	api.PATCH("/labels/:id", h.updateFinderLabel)
	api.DELETE("/labels/:id", h.deleteFinderLabel)
	api.GET("/labels/:id/files", h.finderTaggedFiles)
	api.GET("/labels/:id/resources", h.finderTaggedResources)
	api.PUT("/labels/:id/resources", h.setFinderResources)
	api.GET("/folders/:id/labels", h.finderFolderLabels)
	api.POST("/labels/folder-assignments", h.finderFolderAssignments)
	api.PUT("/labels/:id/files", h.setFinderFileLabels)
	api.GET("/files/:id/labels", h.fileFinderLabels)
	api.GET("/folders/children", h.folderChildren)
	api.GET("/folders/search", h.searchFolders)
	api.GET("/folders/:id", h.folderDetail)
	api.POST("/folders", h.createFolder)
	api.PATCH("/folders/:id", h.renameFolder)
	api.POST("/folders/:id/move", h.moveFolder)
	api.DELETE("/folders/:id", h.deleteFolder)
	api.GET("/folders/:id/acls", h.listGrants)
	api.POST("/folders/:id/acls", h.createGrant)
	api.DELETE("/acls/:id", h.revokeGrant)
	api.POST("/permissions/explain", h.explainPermissions)
	api.GET("/permissions/audit", h.permissionAudit)
	api.GET("/audit/documents", h.documentAudit)
	api.GET("/roles/me", h.myRoleBindings)
	api.GET("/roles/bindings", h.listRoleBindings)
	api.POST("/roles/bindings", h.createRoleBinding)
	api.DELETE("/roles/bindings/:id", h.revokeRoleBinding)
	api.POST("/uploads/resumable", h.startResumable)
	api.GET("/uploads/resumable/:id", h.resumableStatus)
	api.PATCH("/uploads/resumable/:id", h.resumableChunk)
	api.POST("/uploads/resumable/:id/complete", h.finishResumable)
	api.DELETE("/uploads/resumable/:id", h.cancelResumable)
	api.POST("/files", h.uploadFile)
	api.GET("/files/replace-target", h.resolveReplaceTarget)
	api.POST("/files/:id/replace", h.replaceFileContent)
	api.GET("/files", h.listFiles)
	api.GET("/files/:id", h.fileMeta)
	api.GET("/files/:id/history", h.fileHistory)
	api.GET("/files/:id/lifecycle", h.fileLifecycle)
	api.PUT("/files/:id/lifecycle", h.setFileLifecycle)
	api.GET("/lifecycle/ledger", h.lifecycleLedger)
	api.GET("/lifecycle/notifications", h.lifecycleNotifications)
	api.POST("/lifecycle/notifications/:id/read", h.readLifecycleNotification)
	api.GET("/lifecycle/policy/:kind/:id", h.getLifecyclePolicy)
	api.PUT("/lifecycle/policy/:kind/:id", h.putLifecyclePolicy)
	api.DELETE("/lifecycle/policy/:kind/:id", h.deleteLifecyclePolicy)
	api.GET("/lifecycle/statistics", h.lifecycleStatistics)
	api.POST("/lifecycle/bulk-due", h.bulkLifecycleDue)
	api.GET("/files/:id/metadata", h.fileMetadata)
	api.PUT("/files/:id/metadata", h.setFileMetadata)
	api.PATCH("/files/:id", h.renameFile)
	api.HEAD("/files/download-zip", h.inspectFilesZip)
	api.GET("/files/download-zip", h.downloadFilesZip)
	api.GET("/files/:id/bytes", h.downloadFile)
	api.GET("/files/:id/preview", h.previewFile)
	api.GET("/files/:id/preview/media", h.previewMedia)
	api.GET("/files/:id/preview/office-pdf", h.previewOfficePDF)
	api.GET("/files/:id/preview/office/pages", h.officePreviewPages)
	api.GET("/files/:id/preview/office/page", h.officePreviewPage)
	api.GET("/files/:id/preview/pdf/pages", h.pdfPreviewPages)
	api.GET("/files/:id/preview/pdf/page", h.pdfPreviewPage)
	api.POST("/files/:id/convert-for-signing", h.convertDOCXForSigning)
	api.POST("/files/:id/print/prepare", h.prepareBrowserPrint)
	api.GET("/files/:id/print/media", h.browserPrintMedia)
	api.GET("/files/:id/print/office-pdf", h.browserPrintOfficePDF)
	api.GET("/files/:id/print/sheets", h.browserPrintSheets)
	api.POST("/files/:id/save", h.saveFile)
	api.POST("/files/:id/move", h.moveFile)
	api.POST("/files/move-batch", h.moveFilesBatch)
	api.POST("/moves/preflight", h.preflightMoves)
	api.GET("/seal-permissions/me", h.mySealPermission)
	api.GET("/seal-permissions", h.listSealUserPermissions)
	api.PUT("/seal-permissions/:id", h.updateSealUserPermission)
	api.GET("/seals", h.listSealAssets)
	api.POST("/seals", h.createSealAsset)
	api.POST("/seals/bulk", h.importSealBundle)
	api.POST("/seals/:id/manage", h.manageSealAsset)
	api.GET("/seals/:id/image", h.sealImage)
	api.GET("/files/:id/seals/used", h.usedFileSeals)
	api.GET("/files/:id/seals", h.listFileSealMarks)
	api.GET("/files/:id/seals/revisions", h.sealRevisionHistory)
	api.POST("/files/:id/seals/restore", h.restoreSealRevision)
	api.POST("/files/:id/seals/marks/revoke", h.revokeFileMarks)
	api.POST("/files/:id/seals", h.signFileSeal)
	api.POST("/files/:id/seals/batch", h.signFileSealsBatch)
	api.GET("/files/:id/seals/export", h.exportFileSealPDF)
	api.GET("/files/:id/seals/page", h.fileSealPageImage)
	api.GET("/files/:id/seals/:mid/image", h.fileSealMarkImage)
	api.GET("/files/:id/versions", h.fileVersions)
	api.GET("/files/:id/versions/compare", h.compareFileVersions)
	api.GET("/files/:id/review-comments", h.listFileReviewComments)
	api.POST("/files/:id/review-comments", h.createFileReviewComment)
	api.POST("/files/:id/review-comments/:cid/resolve", h.resolveFileReviewComment)
	api.POST("/files/:id/rollback", h.rollbackFile)
	api.DELETE("/files/:id", h.deleteFile)
	api.GET("/users", h.listUsers)
	api.POST("/users", h.createUser)
	api.POST("/users/:id/password", h.resetUserPassword)
	api.POST("/users/:id/:state", h.setUserDisabled)
	api.GET("/departments", h.listDepartments)
	api.POST("/departments", h.createDepartment)
	api.GET("/groups", h.listWorkgroups)
	api.POST("/groups", h.createWorkgroup)
	api.DELETE("/groups/:id", h.deleteWorkgroup)
	api.GET("/groups/:id/members", h.workgroupMembers)
	api.POST("/groups/:id/members", h.addWorkgroupMember)
	api.DELETE("/groups/:id/members/:uid", h.removeWorkgroupMember)
	api.POST("/files/:id/lock", h.acquireLock)
	api.POST("/files/:id/lock/renew", h.renewLock)
	api.DELETE("/files/:id/lock", h.releaseLock)
	api.GET("/files/:id/lock", h.lockStatus)
	api.GET("/workbench/dhf/tasks", h.dhfPilotWorkbenchTasks)
	api.GET("/workbench/dhf/tasks/:id/evidence", h.dhfPilotEvidenceList)
	api.GET("/workbench/dhf/tasks/:id/evidence/:rid/preview", h.dhfPilotEvidencePreview)
	api.GET("/workbench/dhf/tasks/:id/evidence/:rid/pages", h.dhfPilotFrozenPages)
	api.GET("/workbench/dhf/tasks/:id/evidence/:rid/page", h.dhfPilotFrozenPage)
	api.POST("/workbench/dhf/tasks/:id/recommendation", h.dhfPilotRecommend)
	api.GET("/workbench/dhf/duties", h.dhfPilotDutyChain)
	api.GET("/workbench/dhf/attestations", h.dhfPilotAttestationInbox)
	api.GET("/workbench/dhf/gates/:submissionId/verification", h.dhfPilotGateVerification)
	api.GET("/workbench/dhf/gates/:submissionId/readiness", h.dhfStageGateReadiness)
	api.POST("/workbench/dhf/gates/:submissionId/review-request", h.dhfStageGateRequest)
	api.GET("/workbench/dhf/gate-decision-reviews", h.dhfGateDecisionReviewInbox)
	api.POST("/workbench/dhf/gate-decision-reviews/:reviewId/recommendation", h.dhfGateDecisionReviewRecommend)
	api.GET("/workbench/dhf/conditional-plans", h.dhfConditionalPlanCatalog)
	api.POST("/workbench/dhf/conditional-plans", h.dhfConditionalPlanFile)
	api.POST("/workbench/dhf/conditional-plans/:id/withdraw", h.dhfConditionalPlanWithdraw)
	api.GET("/workbench/dhf/credentials", h.dhfPilotCredentialList)
	api.POST("/workbench/dhf/credentials", h.dhfPilotCredentialRegister)
	api.POST("/workbench/dhf/credentials/:id/events", h.dhfPilotCredentialEvent)
	api.POST("/workbench/dhf/tasks/:id/attest", h.dhfPilotAttestReview)
	api.POST("/workbench/dhf/tasks/:id/early-intervention", h.dhfPilotAuthorizeEarlyReview)
	api.GET("/workbench/dhf/returns", h.dhfPilotReturns)
	api.POST("/workbench/dhf/returns/:id/remediation", h.dhfPilotOpenRemediation)
	api.GET("/workbench/dhf/verifications", h.dhfPilotVerificationInbox)
	api.POST("/workbench/dhf/remediations/:id/verify", h.dhfPilotVerifyRemediation)
	api.GET("/approvals", h.listApprovals)
	api.GET("/approvals/:id", h.getApprovalDetail)
	api.GET("/approvals/:id/draft", h.downloadApprovalDraft)
	api.GET("/approvals/:id/draft/preview", h.previewApprovalDraft)
	api.GET("/approvals/:id/draft/media", h.previewApprovalDraftMedia)
	api.GET("/approvals/:id/draft/compare", h.compareApprovalDraft)
	api.POST("/approvals/:id/approve", h.approveApproval)
	api.POST("/approvals/:id/reject", h.rejectApproval)
	api.POST("/approvals/:id/cancel", h.cancelApproval)
	api.GET("/approvals/:id/history", h.approvalHistory)
	api.GET("/approvals/notifications", h.approvalNotifications)
	api.POST("/approvals/notifications/:id/read", h.readApprovalNotification)
	api.GET("/folders/:id/approval-policy", h.getApprovalPolicy)
	api.PUT("/folders/:id/approval-policy", h.setApprovalPolicy)
	api.DELETE("/folders/:id/approval-policy", h.clearApprovalPolicy)
	api.POST("/files/:id/office/session", h.openOfficeSession)
	api.GET("/files/:id/office/session/:sid/state", h.nativeOfficeSaveStatus)
	api.POST("/files/:id/office/session/:sid/save", h.saveOfficeSession)
	api.GET("/files/:id/office/session/:sid/save/:rid", h.officeSaveStatus)
	api.POST("/files/:id/office/session/:sid/cancel", h.cancelOfficeSession)
	r.GET("/api/internal/office/source/:token", h.officeSource)
	r.POST("/api/internal/office/callback", h.officeCallback)
	api.POST("/files/:id/derivative", h.requestDerivative)
	api.GET("/files/:id/derivative", h.derivativeStatus)
	api.GET("/files/:id/derivative/bytes", h.derivativeBytes)
	api.GET("/formats/cad", h.formatMatrix)
	api.GET("/shares", h.listShares)
	api.POST("/shares", h.createShare)
	api.DELETE("/shares/:id", h.revokeShare)
	api.GET("/share-recipients", h.shareRecipients)
	api.GET("/favorites", h.listFavorites)
	api.GET("/favorites/notifications", h.listFavoriteNotifications)
	api.POST("/favorites/notifications/:id/read", h.readFavoriteNotification)
	api.PUT("/favorites/:kind/:id", h.setFavorite)
	api.DELETE("/favorites/:kind/:id", h.setFavorite)
	api.GET("/search", h.searchFiles)
	api.GET("/search/presets", h.listSearchPresets)
	api.POST("/search/presets", h.saveSearchPreset)
	api.DELETE("/search/presets/:name", h.deleteSearchPreset)
	api.GET("/stats", h.statsFiles)
	api.GET("/exports/files.csv", h.exportFiles)
	api.GET("/trash", h.listTrash)
	api.POST("/trash/:id/restore", h.restoreTrash)
	api.DELETE("/trash/:id", h.purgeTrash)
	r.NoRoute(func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			c.JSON(404, gin.H{"ok": false, "error": gin.H{"code": "E_NOT_FOUND"}})
			return
		}
		if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
			c.Status(405)
			return
		}
		path := filepath.Clean(strings.TrimPrefix(c.Request.URL.Path, "/"))
		if path == "." {
			path = "index.html"
		}
		full := filepath.Join(dist, path)
		if !strings.HasPrefix(full, filepath.Clean(dist)+string(filepath.Separator)) {
			c.Status(404)
			return
		}
		info, err := os.Stat(full)
		if err != nil || info.IsDir() {
			full = filepath.Join(dist, "index.html")
		}
		if _, err = os.Stat(full); err != nil {
			c.JSON(404, gin.H{"ok": false, "error": gin.H{"code": "E_UI_NOT_BUILT"}})
			return
		}
		// Revalidate the SPA entry on every navigation so UI updates and removed
		// actions never linger behind a heuristically cached index.html.
		// Fingerprinted JS/CSS assets retain their normal cache behavior.
		if filepath.Base(full) == "index.html" {
			c.Header("Cache-Control", "no-store")
		}
		c.File(full)
	})
	return r
}
func checkOrigin(c *gin.Context) {
	if c.Request.Method == "POST" || c.Request.Method == "PUT" || c.Request.Method == "PATCH" || c.Request.Method == "DELETE" {
		if o := c.GetHeader("Origin"); o != "" {
			u, e := url.Parse(o)
			if e != nil || !strings.EqualFold(u.Host, c.Request.Host) {
				c.JSON(403, gin.H{"ok": false, "error": gin.H{"code": "E_ORIGIN"}})
				c.Abort()
				return
			}
		}
	}
	c.Next()
}

// identity authenticates the active session before any application action.
func (h *Handler) identity(c *gin.Context) (domain.User, bool) {
	token, _ := c.Cookie("fm_session")
	a, err := h.S.Session(c.Request.Context(), token)
	if err != nil {
		if errors.Is(err, application.ErrUnauthorized) {
			c.JSON(401, gin.H{"ok": false, "error": gin.H{"code": "E_AUTH"}})
		} else {
			c.JSON(503, gin.H{"ok": false, "error": gin.H{"code": "E_DEPENDENCY"}})
		}
		return domain.User{}, false
	}
	c.Set("auditActorID", a.User.ID)
	return a.User, true
}

// Authenticated sessions are not subject to forced first-login password change.
// Department, role and ACL authorization remain enforced by the service layer.
func (h *Handler) auth(c *gin.Context) (domain.User, bool) {
	return h.identity(c)
}
func (h *Handler) login(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
	var req struct {
		Login    string
		Password string
	}
	if c.ShouldBindJSON(&req) != nil {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	if wait := h.LoginLimit.allow(loginClientAddr(c.Request), req.Login); wait > 0 {
		c.Header("Retry-After", strconv.Itoa(retrySeconds(wait)))
		c.JSON(429, gin.H{"ok": false, "error": gin.H{"code": "E_RATE_LIMIT"}})
		return
	}
	if !h.LoginLimit.acquire() {
		c.Header("Retry-After", "1")
		c.JSON(429, gin.H{"ok": false, "error": gin.H{"code": "E_RATE_LIMIT"}})
		return
	}
	defer h.LoginLimit.release()
	ctx, cancel := context.WithTimeout(c.Request.Context(), 4*time.Second)
	defer cancel()
	peerIP, _, _ := net.SplitHostPort(loginClientAddr(c.Request))
	ctx = application.WithLoginNetworkMetadata(ctx, peerIP, c.Request.UserAgent(), clientMACFromARP(peerIP))
	token, user, err := h.S.Login(ctx, req.Login, req.Password)
	if err != nil {
		if errors.Is(err, application.ErrInvalidCredentials) || errors.Is(err, application.ErrInvalidInput) {
			c.JSON(401, gin.H{"ok": false, "error": gin.H{"code": "E_INVALID_CREDENTIALS"}})
		} else {
			c.JSON(503, gin.H{"ok": false, "error": gin.H{"code": "E_DEPENDENCY"}})
		}
		return
	}
	c.SetSameSite(http.SameSiteStrictMode)
	c.SetCookie("fm_session", token, 86400, "/", "", h.SecureCookies, true)
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"id": user.ID, "displayName": user.DisplayName, "isAdmin": user.IsAdmin, "mustChangePassword": user.MustChangePassword}})
}
func (h *Handler) logout(c *gin.Context) {
	token, _ := c.Cookie("fm_session")
	if err := h.S.Logout(c.Request.Context(), token); err != nil && !errors.Is(err, application.ErrUnauthorized) {
		// Revocation not confirmed: preserve the cookie and report failure.
		c.JSON(http.StatusServiceUnavailable, gin.H{"ok": false, "error": gin.H{"code": "E_LOGOUT_FAILED"}})
		return
	}
	c.SetSameSite(http.SameSiteStrictMode)
	c.SetCookie("fm_session", "", -1, "/", "", h.SecureCookies, true)
	c.JSON(200, gin.H{"ok": true})
}
func (h *Handler) me(c *gin.Context) {
	u, ok := h.identity(c)
	if !ok {
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"id": u.ID, "displayName": u.DisplayName, "isAdmin": u.IsAdmin, "mustChangePassword": u.MustChangePassword}})
}
func (h *Handler) folders(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
	defer cancel()
	items, err := h.S.Folders(ctx, u)
	if err != nil {
		c.JSON(503, gin.H{"ok": false, "error": gin.H{"code": "E_DEPENDENCY"}})
		return
	}
	data := make([]gin.H, 0, len(items))
	for _, f := range items {
		data = append(data, folderPayload(f))
	}
	c.JSON(200, gin.H{"ok": true, "data": data})
}
