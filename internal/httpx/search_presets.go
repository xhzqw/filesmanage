package httpx

import(
 "encoding/json"
 "filesmanage/internal/domain"
 "github.com/gin-gonic/gin"
)
func(h *Handler) listSearchPresets(c *gin.Context){
 u,ok:=h.auth(c);if !ok{return}
 items,err:=h.S.ListSearchPresets(c.Request.Context(),u);if err!=nil{respondError(c,err);return}
 c.JSON(200,gin.H{"ok":true,"data":items})
}
func(h *Handler) saveSearchPreset(c *gin.Context){
 u,ok:=h.auth(c);if !ok{return}
 var p domain.SearchPreset
 if err:=c.ShouldBindJSON(&p);err!=nil{respondError(c,domain.ErrInvalidInput);return}
 if len(p.Fields)==0||!json.Valid(p.Fields){respondError(c,domain.ErrInvalidInput);return}
 items,err:=h.S.SaveSearchPreset(c.Request.Context(),u,p);if err!=nil{respondError(c,err);return}
 c.JSON(200,gin.H{"ok":true,"data":items})
}
func(h *Handler) deleteSearchPreset(c *gin.Context){
 u,ok:=h.auth(c);if !ok{return}
 err:=h.S.RemoveSearchPreset(c.Request.Context(),u,c.Param("name"));if err!=nil{respondError(c,err);return}
 c.JSON(200,gin.H{"ok":true,"data":gin.H{"deleted":true}})
}
