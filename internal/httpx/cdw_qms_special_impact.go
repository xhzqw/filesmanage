package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
	"strconv"
)

func (h *Handler) cdwQMSSpecialEvidence(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	reader, source, err := h.S.CDWQMSSpecialEvidence(c.Request.Context(), actor, c.Param("id"))
	if err != nil {
		cdwError(c, err)
		return
	}
	defer reader.Close()
	contentType := "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	if source.Format == "pdf" {
		contentType = "application/pdf"
	}
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", `attachment; filename="CDW-QMS-exact-policy.`+source.Format+`"`)
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cache-Control", "no-store")
	c.Header("X-CDW-Artifact-SHA256", source.SHA256)
	c.Header("X-CDW-Release-ID", source.ReleaseID)
	c.Header("Content-Length", strconv.FormatInt(source.SizeBytes, 10))
	c.Status(http.StatusOK)
	_, _ = copyReader(c.Writer, reader)
}
func (h *Handler) cdwQMSSpecialImpacts(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	items, err := h.S.CDWQMSSpecialImpacts(c.Request.Context(), actor)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"items": items}})
}
func (h *Handler) cdwQMSSpecialAssessImpact(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWQMSSpecialImpactInput
	if !cdwBind(c, &input) {
		return
	}
	out, err := h.S.CDWQMSSpecialAssessImpact(c.Request.Context(), actor, c.Param("id"), input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": out})
}
