package httpx

import (
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net/http"
	"strconv"
	"strings"
)

func (h *Handler) dhfTemplate(c *gin.Context) {
	if _, ok := h.auth(c); !ok {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": application.DHFOutline()})
}
func (h *Handler) dhfProjects(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	out, err := h.S.DHFProjects(c.Request.Context(), actor)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": out})
}
func (h *Handler) dhfCreate(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var in application.DHFCreateInput
	if !cdwBind(c, &in) {
		return
	}
	out, err := h.S.DHFCreate(c.Request.Context(), actor, in, key)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": out})
}
func (h *Handler) dhfDetail(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	out, err := h.S.DHFDetail(c.Request.Context(), actor, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": out})
}
func (h *Handler) dhfItemAction(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	rev, ok := cdwIfMatch(c)
	if !ok {
		return
	}
	line, err := strconv.Atoi(c.Param("line"))
	if err != nil || line < 2 {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	var in application.DHFItemAction
	if !cdwBind(c, &in) {
		return
	}
	out, err := h.S.DHFActItem(c.Request.Context(), actor, c.Param("id"), line, rev, in, key)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": out})
}
func (h *Handler) dhfAcceptStage(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	stage, err := strconv.Atoi(c.Param("stage"))
	if err != nil || stage < 1 || stage > 9 {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	var in application.DHFStageAction
	if !cdwBind(c, &in) {
		return
	}
	out, err := h.S.DHFAcceptStage(c.Request.Context(), actor, c.Param("id"), stage, in, key)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": out})
}

func (h *Handler) dhfFileVersions(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	out, err := h.S.DHFFileVersions(c.Request.Context(), actor, c.Param("fileId"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": out})
}

// dhfPinnedEvidence streams the exact accepted/submitted bytes, never latest.
func (h *Handler) dhfPinnedEvidence(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	line, err := strconv.Atoi(c.Param("line"))
	if err != nil || line < 1 {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	out, closeFn, err := h.S.DHFOpenEvidence(c.Request.Context(), actor, c.Param("id"), line)
	if err != nil {
		respondError(c, err)
		return
	}
	defer closeFn()
	mime := contentTypeOr(out.ContentType)
	c.Header("Content-Type", mime)
	c.Header("X-Content-Sha256", out.Sha256)
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cross-Origin-Resource-Policy", "same-origin")
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("Cache-Control", "private, no-store")
	// Passive browser-safe content is shown inline. Office documents and any
	// active HTML/SVG/script formats stay attachments to avoid same-origin XSS.
	safe := mime == "application/pdf" || mime == "text/plain" || strings.HasPrefix(mime, "image/png") || strings.HasPrefix(mime, "image/jpeg") || strings.HasPrefix(mime, "image/gif") || strings.HasPrefix(mime, "image/webp")
	if safe {
		c.Header("Content-Disposition", "inline")
	} else {
		c.Header("Content-Disposition", contentDisposition(out.FileName))
	}
	http.ServeContent(c.Writer, c.Request, out.FileName, out.ModTime, out.Reader)
}

func (h *Handler) dhfAuditProof(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	after := int64(0)
	if c.Query("after") != "" {
		v, err := strconv.ParseInt(c.Query("after"), 10, 64)
		if err != nil {
			respondError(c, domain.ErrInvalidInput)
			return
		}
		after = v
	}
	limit := 100
	if c.Query("limit") != "" {
		v, err := strconv.Atoi(c.Query("limit"))
		if err != nil {
			respondError(c, domain.ErrInvalidInput)
			return
		}
		limit = v
	}
	proof, err := h.S.DHFProof(c.Request.Context(), actor, c.Param("id"), after, limit)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.JSON(200, gin.H{"ok": true, "data": proof})
}
