package httpx

import (
	"github.com/gin-gonic/gin"
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
