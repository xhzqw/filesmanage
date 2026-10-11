package httpx
import(
 "filesmanage/internal/application"
 "filesmanage/internal/domain"
 "github.com/gin-gonic/gin"
 "net/http"
)
func(h *Handler)getLifecyclePolicy(c *gin.Context){
 u,ok:=h.auth(c);if !ok{return}
 v,e:=h.S.LifecyclePolicy(c.Request.Context(),u,c.Param("kind"),c.Param("id"))
 if e!=nil{respondError(c,e);return}
 c.JSON(200,gin.H{"ok":true,"data":v})
}
func(h *Handler)putLifecyclePolicy(c *gin.Context){
 u,ok:=h.auth(c);if !ok{return}
 c.Request.Body=http.MaxBytesReader(c.Writer,c.Request.Body,1024)
 var value domain.LifecyclePolicy
 if e:=c.ShouldBindJSON(&value);e!=nil{respondError(c,domain.ErrInvalidInput);return}
 if e:=h.S.SetLifecyclePolicy(c.Request.Context(),u,c.Param("kind"),c.Param("id"),&value);e!=nil{respondError(c,e);return}
 c.JSON(200,gin.H{"ok":true,"data":gin.H{"saved":true}})
}
func(h *Handler)deleteLifecyclePolicy(c *gin.Context){
 u,ok:=h.auth(c);if !ok{return}
 if e:=h.S.SetLifecyclePolicy(c.Request.Context(),u,c.Param("kind"),c.Param("id"),nil);e!=nil{respondError(c,e);return}
 c.JSON(200,gin.H{"ok":true,"data":gin.H{"cleared":true}})
}
func(h *Handler)lifecycleStatistics(c *gin.Context){
 u,ok:=h.auth(c);if !ok{return}
 v,e:=h.S.LifecycleStatistics(c.Request.Context(),u)
 if e!=nil{respondError(c,e);return}
 c.JSON(200,gin.H{"ok":true,"data":v})
}
func(h *Handler)bulkLifecycleDue(c *gin.Context){
 u,ok:=h.auth(c);if !ok{return}
 c.Request.Body=http.MaxBytesReader(c.Writer,c.Request.Body,4096)
 var request application.LifecycleBulkDueRequest
 if e:=c.ShouldBindJSON(&request);e!=nil{respondError(c,domain.ErrInvalidInput);return}
 v,e:=h.S.BulkLifecycleDue(c.Request.Context(),u,request)
 if e!=nil{respondError(c,e);return}
 c.JSON(200,gin.H{"ok":true,"data":v})
}
