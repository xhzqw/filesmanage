package httpx

import (
 "filesmanage/internal/domain"
 "github.com/gin-gonic/gin"
 "net/http"
 "strconv"
)

// Only server-rendered PNG is returned. Browser PDF extensions and a mutable
// Finder /files/:id/preview endpoint are never used for DHF review evidence.
func(h *Handler) dhfPilotFrozenPages(c *gin.Context){
 actor,ok:=h.auth(c);if !ok{return}
 count,err:=h.S.DHFPilotFrozenPages(c.Request.Context(),actor,c.Param("id"),c.Param("rid"))
 if err!=nil{respondError(c,err);return}
 c.Header("Cache-Control","private, no-store")
 c.JSON(http.StatusOK,gin.H{"ok":true,"data":gin.H{
  "pageCount":count,"immutable":true,"trialOnly":true,
 }})
}

func(h *Handler) dhfPilotFrozenPage(c *gin.Context){
 actor,ok:=h.auth(c);if !ok{return}
 page,err:=strconv.Atoi(c.Query("page"))
 if err!=nil||page<1||page>1000{respondError(c,domain.ErrInvalidInput);return}
 image,err:=h.S.DHFPilotFrozenPage(c.Request.Context(),actor,c.Param("id"),c.Param("rid"),page)
 if err!=nil{respondError(c,err);return}
 servePrivateSealPNG(c,image)
}
