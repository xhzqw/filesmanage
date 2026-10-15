package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"strconv"
)

// CAD preview endpoints: request a derivative, poll its state and fetch the
// derivative bytes. Native formats are served straight from the source blob.

func (h *Handler) requestDerivative(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	derivative, err := h.S.RequestDerivative(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(202, gin.H{"ok": true, "data": gin.H{
		"derivativeId": derivative.ID, "state": derivative.State,
		"sourceFormat": derivative.SourceFormat, "outputKind": derivative.OutputKind,
		"converter": derivative.Converter,
	}})
}

func (h *Handler) derivativeStatus(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	derivative, support, found, err := h.S.DerivativeStatus(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	if !found {
		state := ""
		errorCode := ""
		if support.Class == "invalid" {
			state = "invalid"
			errorCode = "INVALID_DWG"
		}
		c.JSON(200, gin.H{"ok": true, "data": gin.H{
			"found": false, "format": support.Format, "class": support.Class,
			"engine": support.Engine, "note": support.Note, "state": state, "errorCode": errorCode,
		}})
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{
		"found": true, "state": derivative.State, "outputKind": derivative.OutputKind,
		"sourceFormat": derivative.SourceFormat, "format": support.Format,
		"converter":    derivative.Converter,
		"outputSha256": derivative.OutputSha256, "outputSize": derivative.OutputSize,
		"errorCode": derivative.ErrorCode, "class": support.Class, "note": support.Note,
	}})
}

func (h *Handler) derivativeBytes(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	reader, _, size, contentType, sha, closeReader, err := h.S.OpenDerivative(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	defer closeReader()
	c.Header("Content-Type", contentType)
	c.Header("Content-Length", strconv.FormatInt(size, 10))
	c.Header("X-Content-Sha256", sha)
	c.Status(200)
	_, _ = copyReader(c.Writer, reader)
}

func (h *Handler) formatMatrix(c *gin.Context) {
	_, ok := h.auth(c)
	if !ok {
		return
	}
	formats := application.FormatMatrix()
	data := make([]gin.H, 0, len(formats))
	for _, f := range formats {
		data = append(data, gin.H{
			"format": f.Format, "class": f.Class, "engine": f.Engine, "note": f.Note,
		})
	}
	c.JSON(200, gin.H{"ok": true, "data": data})
}
