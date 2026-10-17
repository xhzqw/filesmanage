package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) cdwQMSEscalationPolicies(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	out, err := h.S.CDWQMSEscalationPolicies(c.Request.Context(), actor)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"items": out}})
}
func (h *Handler) cdwQMSEscalationPropose(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWQMSEscalationProposalInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWQMSEscalationPropose(c.Request.Context(), actor, input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": out})
}
func (h *Handler) cdwQMSEscalationVerify(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWQMSEscalationReasonInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWQMSEscalationVerify(c.Request.Context(), actor, c.Param("id"), input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": out})
}
func (h *Handler) cdwQMSEscalationCases(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	out, err := h.S.CDWQMSEscalationCases(c.Request.Context(), actor)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"items": out}})
}
func (h *Handler) cdwQMSEscalationOpen(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWQMSEscalationOpenInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWQMSEscalationOpen(c.Request.Context(), actor, c.Param("id"), input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": out})
}
func (h *Handler) cdwQMSEscalationResolve(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWQMSEscalationReasonInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWQMSEscalationResolve(c.Request.Context(), actor, c.Param("id"), input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": out})
}
