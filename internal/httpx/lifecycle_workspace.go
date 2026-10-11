package httpx
import(
 "filesmanage/internal/domain"
 "github.com/gin-gonic/gin"
 "strconv"
)
func(h *Handler)lifecycleLedger(c *gin.Context){
 u,ok:=h.auth(c);if !ok{return}
 limit:=30
 if raw:=c.Query("limit");raw!=""{n,e:=strconv.Atoi(raw);if e!=nil{respondError(c,domain.ErrInvalidInput);return};limit=n}
 rows,err:=h.S.LifecycleLedger(c.Request.Context(),u,c.Query("cursor"),c.Query("state"),limit)
 if err!=nil{respondError(c,err);return}
 c.JSON(200,gin.H{"ok":true,"data":rows})
}
func(h *Handler)lifecycleNotifications(c *gin.Context){
 u,ok:=h.auth(c);if !ok{return}
 rows,err:=h.S.LifecycleNotifications(c.Request.Context(),u)
 if err!=nil{respondError(c,err);return}
 c.JSON(200,gin.H{"ok":true,"data":rows})
}
func(h *Handler)readLifecycleNotification(c *gin.Context){
 u,ok:=h.auth(c);if !ok{return}
 id,err:=strconv.ParseInt(c.Param("id"),10,64)
 if err!=nil{respondError(c,domain.ErrInvalidInput);return}
 if err=h.S.ReadLifecycleNotification(c.Request.Context(),u,id);err!=nil{respondError(c,err);return}
 c.JSON(200,gin.H{"ok":true,"data":gin.H{"read":id})
}
