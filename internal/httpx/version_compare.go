package httpx
import("net/http";"strconv";"filesmanage/internal/domain";"github.com/gin-gonic/gin")
func(h *Handler) compareFileVersions(c *gin.Context){
 u,ok:=h.auth(c);if !ok{return}
 a,err:=strconv.Atoi(c.Query("left"));if err!=nil{respondError(c,domain.ErrInvalidInput);return}
 b,err:=strconv.Atoi(c.Query("right"));if err!=nil{respondError(c,domain.ErrInvalidInput);return}
 out,err:=h.S.CompareVersions(c.Request.Context(),u,c.Param("id"),a,b)
 if err!=nil{respondError(c,err);return};c.JSON(http.StatusOK,gin.H{"ok":true,"data":out})
}
