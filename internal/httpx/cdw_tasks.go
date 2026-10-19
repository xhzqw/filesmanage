package httpx

import (
	"encoding/json"
	"errors"
	"filesmanage/internal/application"
	"filesmanage/internal/ports"
	"github.com/gin-gonic/gin"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func cdwBind(c *gin.Context, target any) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 8192)
	d := json.NewDecoder(c.Request.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return false
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return false
	}
	return true
}
func cdwKey(c *gin.Context) (string, bool) {
	key := strings.TrimSpace(c.GetHeader("Idempotency-Key"))
	if len(key) < 8 || len(key) > 128 {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_CD_IDEMPOTENCY_REQUIRED"}})
		return "", false
	}
	for _, ch := range key {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '-' || ch == '_') {
			c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_CD_IDEMPOTENCY_REQUIRED"}})
			return "", false
		}
	}
	return key, true
}
func cdwIfMatch(c *gin.Context) (int64, bool) {
	value := c.GetHeader("If-Match")
	if !strings.HasPrefix(value, "\"rev-") || !strings.HasSuffix(value, "\"") {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_CD_PRECONDITION_REQUIRED"}})
		return 0, false
	}
	n, err := strconv.ParseInt(strings.TrimSuffix(strings.TrimPrefix(value, "\"rev-"), "\""), 10, 64)
	if err != nil || n < 1 {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_CD_PRECONDITION_REQUIRED"}})
		return 0, false
	}
	return n, true
}
func cdwError(c *gin.Context, err error) {
	if errors.Is(err, ports.ErrCDWIdempotencyReuse) {
		c.JSON(409, gin.H{"ok": false, "error": gin.H{"code": "E_IDEMPOTENCY_REUSE"}})
		return
	}
	respondError(c, err)
}
func cdwSuccess(c *gin.Context, status int, result ports.CDWTaskResult) {
	c.Header("ETag", "\\\"rev-"+strconv.FormatInt(result.Revision, 10)+"\\\"")
	c.Header("Cache-Control", "no-store")
	c.JSON(status, gin.H{"ok": true, "data": result})
}
func (h *Handler) cdwCreateRoot(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWRootTaskInput
	if !cdwBind(c, &input) {
		return
	}
	result, err := h.S.CDWCreateRootTask(c.Request.Context(), actor, input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	cdwSuccess(c, http.StatusCreated, result)
}
func (h *Handler) cdwAcceptTask(c *gin.Context) {
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
	// A required empty JSON object ensures no browser-supplied actor identity.
	var body struct{}
	if !cdwBind(c, &body) {
		return
	}
	result, err := h.S.CDWAcceptTask(c.Request.Context(), actor, c.Param("id"), rev, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	cdwSuccess(c, http.StatusOK, result)
}
func (h *Handler) cdwDelegateTask(c *gin.Context) {
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
	var input application.CDWChildTaskInput
	if !cdwBind(c, &input) {
		return
	}
	result, err := h.S.CDWDelegateTask(c.Request.Context(), actor, c.Param("id"), input, rev, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	cdwSuccess(c, http.StatusCreated, result)
}
func (h *Handler) cdwInitiatedEvents(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	limit := 30
	if text := c.Query("limit"); text != "" {
		n, err := strconv.Atoi(text)
		if err != nil || n < 1 || n > 100 {
			c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
			return
		}
		limit = n
	}
	var before int64
	if text := c.Query("before"); text != "" {
		value, err := strconv.ParseInt(text, 10, 64)
		if err != nil || value < 1 {
			c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
			return
		}
		before = value
	}
	page, err := h.S.CDWInitiatedTimeline(c.Request.Context(), actor, c.Param("id"), limit, before)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": page})
}
func (h *Handler) cdwInitiated(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	limit := 30
	if raw := c.Query("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
			return
		}
		limit = n
	}
	cursor := strings.TrimSpace(c.Query("cursor"))
	if len(cursor) > 256 {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	page, err := h.S.CDWInitiatedTasks(c.Request.Context(), actor, limit, cursor)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": page})
}

func (h *Handler) cdwInbox(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	limit := 50
	if s := c.Query("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > 100 {
			c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
			return
		}
		limit = n
	}
	items, err := h.S.CDWTaskInbox(c.Request.Context(), actor, limit)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"items": items, "asOf": time.Now().UTC().Format(time.RFC3339Nano), "nextCursor": nil}})
}
