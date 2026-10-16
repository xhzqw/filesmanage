package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) cdwFormalDocumentClass(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	result, err := h.S.CDWDocumentClass(c.Request.Context(), actor, c.Param("fileId"))
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": result})
}

func (h *Handler) cdwFormalDocumentClassify(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	key, ok := cdwKey(c)
	if !ok {
		return
	}
	var input application.CDWDocumentClassInput
	if !cdwBind(c, &input) {
		return
	}
	result, err := h.S.CDWClassifyDocument(c.Request.Context(), actor, c.Param("fileId"), input, key)
	if err != nil {
		cdwError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": result})
}
