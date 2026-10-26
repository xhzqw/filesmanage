package httpx

import "github.com/gin-gonic/gin"

// Task membership by itself NEVER supplies file preview permission; the
// application rechecks the document ACL and original pinned file version.
func(h *Handler) dhfPilotEvidenceList(c *gin.Context){
 actor,ok:=h.auth(c);if !ok{return}
 rows,err:=h.S.DHFPilotReviewerEvidence(c.Request.Context(),actor,c.Param("id"))
 if err!=nil{respondError(c,err);return}
 c.Header("Cache-Control","private, no-store")
 c.JSON(200,gin.H{"ok":true,"data":gin.H{"items":rows,"trialOnly":true}})
}

// Exact fixed-version preview: no mutable current-version shortcut, and no
// HTML/SVG/Office executable bytes served from this JSON endpoint.
func(h *Handler) dhfPilotEvidencePreview(c *gin.Context){
 actor,ok:=h.auth(c);if !ok{return}
 preview,err:=h.S.DHFPilotReviewerEvidencePreview(c.Request.Context(),actor,c.Param("id"),c.Param("rid"))
 if err!=nil{respondError(c,err);return}
 c.Header("Cache-Control","private, no-store")
 c.JSON(200,gin.H{"ok":true,"data":gin.H{
   "fileId":preview.FileID,"name":preview.Name,"contentType":preview.ContentType,
   "size":preview.Size,"sha256":preview.Sha256,
   "textual":preview.Textual,"truncated":preview.Truncated,
   "content":preview.Content,"byteMeta":preview.ByteMeta,
   "renderer":preview.Renderer,"mediaType":preview.MediaType,
   "structured":preview.Structured,
   "fixedVersionVerified":true,
 }})
}
