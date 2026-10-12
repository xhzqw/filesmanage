package httpx

import(
 "errors"
 "filesmanage/internal/application"
 "filesmanage/internal/domain"
 "github.com/gin-gonic/gin"
 "net/http"
 "strconv"
)

// An omitted revision always resolves to the latest committed snapshot.
// Revision 0 is the original, unsigned source document.
func optionalSealRevision(c *gin.Context)(int,error){
 value,exists:=c.GetQuery("revision")
 if !exists{return -1,nil}
 rev,err:=strconv.Atoi(value)
 if err!=nil||rev<0||rev>1000000{return 0,domain.ErrInvalidInput}
 return rev,nil
}

func(h *Handler) sealRevisionHistory(c *gin.Context){
 user,ok:=h.auth(c);if !ok{return}
 seq,err:=strconv.Atoi(c.Query("version"))
 if err!=nil||seq<1{respondError(c,domain.ErrInvalidInput);return}
 history,err:=h.S.SealHistory(c.Request.Context(),user,c.Param("id"),seq)
 if err!=nil{respondError(c,err);return}
 c.Header("Cache-Control","private, no-store")
 c.JSON(http.StatusOK,gin.H{"ok":true,"data":history})
}
func(h *Handler) restoreSealRevision(c *gin.Context){
 user,ok:=h.auth(c);if !ok{return}
 c.Request.Body=http.MaxBytesReader(c.Writer,c.Request.Body,2048)
 var request struct{
  VersionSeq int `json:"versionSeq"`
  FileSha256 string `json:"fileSha256"`
  ExpectedRevision int `json:"expectedRevision"`
  TargetRevision int `json:"targetRevision"`
  Password string `json:"password"`
 }
 if c.ShouldBindJSON(&request)!=nil{respondError(c,domain.ErrInvalidInput);return}
 result,err:=h.S.RestoreSealRevision(c.Request.Context(),user,c.Param("id"),request.VersionSeq,request.FileSha256,request.ExpectedRevision,request.TargetRevision,request.Password)
 if errors.Is(err,application.ErrInvalidCredentials){
  c.JSON(http.StatusForbidden,gin.H{"ok":false,"error":gin.H{"code":"E_SIGN_PASSWORD","message":"回退密码错误"}});return
 }
 if err!=nil{respondError(c,err);return}
 c.Header("Cache-Control","no-store")
 c.JSON(http.StatusCreated,gin.H{"ok":true,"data":result})
}
