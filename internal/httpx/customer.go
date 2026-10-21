package httpx

import (
	"encoding/json"
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"io"
	"net/http"
	"strconv"
)

func customerBind(c *gin.Context, v any) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 131072)
	d := json.NewDecoder(c.Request.Body)
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return false
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return false
	}
	return true
}
func customerOK(c *gin.Context, status int, value any) {
	c.Header("Cache-Control", "no-store")
	c.JSON(status, gin.H{"ok": true, "data": value})
}
func (h *Handler) customerList(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	limit := 50
	if raw := c.Query("limit"); raw != "" {
		n, e := strconv.Atoi(raw)
		if e != nil || n < 1 || n > 100 {
			respondError(c, application.ErrInvalidInput)
			return
		}
		limit = n
	}
	out, err := h.S.CustomerList(c.Request.Context(), actor, c.Query("q"), c.Query("category"), c.Query("status"), c.Query("cursor"), limit)
	if err != nil {
		respondError(c, err)
		return
	}
	customerOK(c, 200, out)
}
func (h *Handler) customerGet(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	out, err := h.S.CustomerGet(c.Request.Context(), actor, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	customerOK(c, 200, out)
}
func (h *Handler) customerCreate(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	var input application.CustomerWriteInput
	if !customerBind(c, &input) {
		return
	}
	out, err := h.S.CustomerCreate(c.Request.Context(), actor, input)
	if err != nil {
		respondError(c, err)
		return
	}
	customerOK(c, 201, out)
}
func (h *Handler) customerUpdate(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	var input application.CustomerWriteInput
	if !customerBind(c, &input) {
		return
	}
	out, err := h.S.CustomerUpdate(c.Request.Context(), actor, c.Param("id"), input)
	if err != nil {
		respondError(c, err)
		return
	}
	customerOK(c, 200, out)
}
func (h *Handler) customerEvents(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	out, err := h.S.CustomerHistory(c.Request.Context(), actor, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	customerOK(c, 200, gin.H{"items": out})
}
func (h *Handler) customerSubmitRegistration(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	var input struct {
		ReviewerID string `json:"reviewerId"`
	}
	if !customerBind(c, &input) {
		return
	}
	out, err := h.S.CustomerSubmitRegistration(c.Request.Context(), actor, c.Param("id"), input.ReviewerID)
	if err != nil {
		respondError(c, err)
		return
	}
	customerOK(c, 201, out)
}
func (h *Handler) customerRegistrations(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	out, err := h.S.CustomerRegistrations(c.Request.Context(), actor, c.DefaultQuery("scope", "inbox"))
	if err != nil {
		respondError(c, err)
		return
	}
	customerOK(c, 200, gin.H{"items": out})
}
func (h *Handler) customerRegistrationGet(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	out, err := h.S.CustomerRegistrationGet(c.Request.Context(), actor, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	customerOK(c, 200, out)
}
func (h *Handler) customerRegistrationDecide(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	revision, ok := cdwIfMatch(c)
	if !ok {
		return
	}
	var input struct {
		Decision string `json:"decision"`
		Reason   string `json:"reason"`
	}
	if !customerBind(c, &input) {
		return
	}
	out, err := h.S.CustomerDecideRegistration(c.Request.Context(), actor, c.Param("id"), revision, input.Decision, input.Reason)
	if err != nil {
		respondError(c, err)
		return
	}
	customerOK(c, 200, out)
}
