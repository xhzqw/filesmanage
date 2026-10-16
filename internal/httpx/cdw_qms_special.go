package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) cdwQMSSpecialPropose(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWQMSSpecialInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWQMSSpecialPropose(c.Request.Context(), actor, input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": out})
}
func (h *Handler) cdwQMSSpecialReview(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	if c.Param("action") != "verify" && c.Param("action") != "revoke" &&
		c.Param("action") != "return" && c.Param("action") != "reject" {
		c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": gin.H{"code": "E_NOT_FOUND"}})
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWQMSSpecialReviewInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWQMSSpecialReview(c.Request.Context(), actor, c.Param("id"), input,
		c.Param("action"), key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": out})
}
func (h *Handler) cdwQMSSpecialList(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	items, err := h.S.CDWQMSSpecialList(c.Request.Context(), actor)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"items": items}})
}
func (h *Handler) cdwQMSSpecialAlerts(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	items, err := h.S.CDWQMSSpecialAlerts(c.Request.Context(), actor)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"items": items}})
}
func (h *Handler) cdwQMSSpecialReadAlert(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	out, err := h.S.CDWQMSSpecialReadAlert(c.Request.Context(), actor, c.Param("id"), key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": out})
}
