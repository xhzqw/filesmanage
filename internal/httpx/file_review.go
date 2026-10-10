package httpx
import("net/http";"strconv";"filesmanage/internal/domain";"github.com/gin-gonic/gin")
func(h *Handler) listFileReviewComments(c *gin.Context){
 u,ok:=h.auth(c);if !ok{return}
 version,err:=strconv.Atoi(c.Query("version"));if err!=nil{respondError(c,domain.ErrInvalidInput);return}
 limit:=30;if raw:=c.Query("limit");raw!=""{limit,err=strconv.Atoi(raw);if err!=nil{respondError(c,domain.ErrInvalidInput);return}}
 page,err:=h.S.ReviewComments(c.Request.Context(),u,c.Param("id"),version,c.Query("cursor"),limit)
 if err!=nil{respondError(c,err);return};c.JSON(http.StatusOK,gin.H{"ok":true,"data":page})
}
func(h *Handler) createFileReviewComment(c *gin.Context){
 u,ok:=h.auth(c);if !ok{return}
 c.Request.Body=http.MaxBytesReader(c.Writer,c.Request.Body,8192)
 var req struct{Version int `json:"version"`;LineNumber *int `json:"lineNumber"`;Body string `json:"body"`}
 if c.ShouldBindJSON(&req)!=nil{respondError(c,domain.ErrInvalidInput);return}
 out,err:=h.S.AddReviewComment(c.Request.Context(),u,c.Param("id"),req.Version,req.LineNumber,req.Body)
 if err!=nil{respondError(c,err);return};c.JSON(http.StatusCreated,gin.H{"ok":true,"data":out})
}
func(h *Handler) resolveFileReviewComment(c *gin.Context){
 u,ok:=h.auth(c);if !ok{return}
 id,err:=strconv.ParseInt(c.Param("cid"),10,64);if err!=nil{respondError(c,domain.ErrInvalidInput);return}
 if err=h.S.ResolveReviewComment(c.Request.Context(),u,c.Param("id"),id);err!=nil{respondError(c,err);return}
 c.JSON(http.StatusOK,gin.H{"ok":true,"data":gin.H{"resolved":id}})
}
