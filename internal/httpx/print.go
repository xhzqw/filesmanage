package httpx

import (
	"net/http"

	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
)

func hexSHA(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, ch := range s {
		if !((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')) {
			return false
		}
	}
	return true
}

func (h *Handler) prepareBrowserPrint(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var input struct {
		ExpectedSha256 string `json:"expectedSha256"`
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2048)
	if c.ShouldBindJSON(&input) != nil || !hexSHA(input.ExpectedSha256) {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	out, err := h.S.PrepareBrowserPrint(c.Request.Context(), u, c.Param("id"), input.ExpectedSha256)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": out})
}

func (h *Handler) browserPrintMedia(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	sha := c.Query("sha256")
	if !hexSHA(sha) {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	source, done, err := h.S.OpenBrowserPrintMedia(c.Request.Context(), u, c.Param("id"), sha)
	if err != nil {
		if err == application.ErrPreviewUnsupported {
			c.JSON(415, gin.H{"ok": false, "error": gin.H{"code": "E_PREVIEW_UNSUPPORTED"}})
			return
		}
		respondError(c, err)
		return
	}
	defer done()
	c.Header("Content-Type", source.ContentType)
	c.Header("Content-Disposition", "inline")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cache-Control", "private, no-store")
	c.Header("Cross-Origin-Resource-Policy", "same-origin")
	c.Header("Referrer-Policy", "no-referrer")
	http.ServeContent(c.Writer, c.Request, "", source.ModTime, source.Reader)
}

func (h *Handler) browserPrintOfficePDF(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	sha := c.Query("sha256")
	if !hexSHA(sha) {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
 sheet:=c.Query("sheet")
 if len(sheet)>200 {c.JSON(400,gin.H{"ok":false,"error":gin.H{"code":"E_BAD"}});return}
 pdf, err := h.S.BrowserPrintOfficePDFSheet(c.Request.Context(), u, c.Param("id"), sha,sheet)
	if err != nil {
		if err == application.ErrPreviewUnsupported {
			c.JSON(415, gin.H{"ok": false, "error": gin.H{"code": "E_PREVIEW_UNSUPPORTED"}})
			return
		}
		respondError(c, err)
		return
	}
	c.Header("Content-Disposition", "inline")
	c.Header("Cache-Control", "private, no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cross-Origin-Resource-Policy", "same-origin")
	c.Header("Content-Security-Policy", "sandbox")
	c.Data(200, "application/pdf", pdf)
}

func (h *Handler) browserPrintSheets(c *gin.Context) {
 u,ok:=h.auth(c)
 if !ok{return}
 sha:=c.Query("sha256")
 if !hexSHA(sha){c.JSON(400,gin.H{"ok":false,"error":gin.H{"code":"E_BAD"}});return}
 sheets,err:=h.S.BrowserPrintSheets(c.Request.Context(),u,c.Param("id"),sha)
 if err!=nil{respondError(c,err);return}
 c.Header("Cache-Control","no-store")
 c.JSON(200,gin.H{"ok":true,"data":sheets})
}
