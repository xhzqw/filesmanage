package httpx

import (
	"github.com/gin-gonic/gin"
	"net/http"
)

// The unified workbench exposes read-only trial DHF assignments. There is no
// approve, return, reassign or electronic-signature route in this pilot.
func (h *Handler) dhfPilotWorkbenchTasks(c *gin.Context) {
	user,ok:=h.auth(c)
	if !ok{return}
	items,err:=h.S.DHFPilotWorkbenchInbox(c.Request.Context(),user)
	if err!=nil{
		respondError(c,err)
		return
	}
	c.Header("Cache-Control","private, no-store")
	c.JSON(200,gin.H{"ok":true,"data":gin.H{"items":items,"trialOnly":true}})
}


// This endpoint stores a non-signing reviewer opinion. It never accepts a
// client-provided actor ID or makes an official DHF stage decision.
func (h *Handler) dhfPilotRecommend(c *gin.Context) {
	user,ok:=h.auth(c)
	if !ok{return}
	c.Request.Body=http.MaxBytesReader(c.Writer,c.Request.Body,4096)
	var req struct {
		Outcome string `json:"outcome"`
		Comment string `json:"comment"`
		IdempotencyKey string `json:"idempotencyKey"`
	}
	if c.ShouldBindJSON(&req)!=nil{
		c.JSON(400,gin.H{"ok":false,"error":gin.H{"code":"E_BAD"}})
		return
	}
	result,err:=h.S.DHFPilotRecommend(c.Request.Context(),user,c.Param("id"),
		req.Outcome,req.Comment,req.IdempotencyKey)
	if err!=nil{
		c.JSON(409,gin.H{"ok":false,"error":gin.H{"code":"DHF_REVIEW_CONFLICT"}})
		return
	}
	if result.Reason!=""{
		status:=409
		if result.Reason=="DHF_SCOPE_DENIED"{status=404}
		if result.Reason=="DHF_REVIEW_OUTCOME_INVALID" || result.Reason=="DHF_REVIEW_COMMENT_INVALID" ||
			result.Reason=="DHF_IDEMPOTENCY_KEY_INVALID"{status=400}
		c.JSON(status,gin.H{"ok":false,"error":gin.H{"code":result.Reason}})
		return
	}
	c.Header("Cache-Control","private, no-store")
	c.JSON(200,gin.H{"ok":true,"data":result})
}
