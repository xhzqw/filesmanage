package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
	"strings"
	"strconv"
)

// Document editor handlers. Session endpoints require modify; the source and
// callback endpoints are internal, token-authenticated, and never rely on the
// browser session cookie.

func (h *Handler) openOfficeSession(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	view, err := h.S.OpenOfficeSession(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	// The document server requires the editor token on the source URL as well;
	// it forwards it when fetching the document.
	sourceURL := h.S.SourceURL() + "/api/internal/office/source/" + view.Token + "?token=" + view.Token
	// ONLYOFFICE expects the whole editor config signed as one JWT presented in
	// the single top-level "token" field.
	config := map[string]any{
		"document": map[string]any{
			"fileType": "docx",
			"key":      view.DocumentKey,
			"title":    view.DocumentKey,
			"url":      sourceURL,
			"permissions": map[string]any{
				"edit": true, "download": false, "print": false,
			},
		},
		"editorConfig": map[string]any{
			"mode":        "edit",
			"callbackUrl": h.S.SourceURL() + "/api/internal/office/callback",
			"user":        map[string]any{"id": u.ID, "name": u.DisplayName},
			"lang":        "zh-CN",
		},
	}
	signed, err := h.S.SignEditorConfig(config)
	if err != nil {
		respondError(c, err)
		return
	}
	// The api.js forwards document.token to the editor, which validates the
	// signature against the received config: send the full config plus token.
	config["token"] = signed
	c.JSON(201, gin.H{"ok": true, "data": gin.H{
		"sessionId": view.SessionID, "documentKey": view.DocumentKey,
		"baseSeq": view.BaseSeq, "editorUrl": view.EditorURL, "config": config,
	}})
}

func (h *Handler) cancelOfficeSession(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if err := h.S.CloseOfficeSession(c.Request.Context(), u, c.Param("sid")); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"cancelled": c.Param("sid")}})
}

func (h *Handler) officeSource(c *gin.Context) {
	reader, name, size, closeReader, err := h.S.EditorSource(c.Request.Context(), c.Param("token"))
	if err != nil {
		respondError(c, err)
		return
	}
	defer closeReader()
	c.Header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	c.Header("Content-Length", strconv.FormatInt(size, 10))
	c.Header("Content-Disposition", contentDisposition(name))
	c.Status(http.StatusOK)
	_, _ = copyReader(c.Writer, reader)
}

// officeCallback receives document-server callbacks. The editor authenticates
// with its own JWT; no browser session is involved.
func (h *Handler) officeCallback(c *gin.Context) {
	authorization := strings.TrimSpace(strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer"))
	var payload application.EditorCallbackPayload
	if c.ShouldBindJSON(&payload) != nil {
		c.JSON(200, gin.H{"error": 1})
		return
	}
	code, err := h.S.HandleEditorCallback(c.Request.Context(), authorization, payload)
	if err != nil {
		c.JSON(200, gin.H{"error": codeOr(code, err)})
		return
	}
	c.JSON(200, gin.H{"error": 0})
}

func codeOr(code int, err error) int {
	if code != 0 {
		return code
	}
	return 1
}
