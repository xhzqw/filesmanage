package httpx

import(
 "archive/zip"
 "context"
 "fmt"
 "io"
 "filesmanage/internal/domain"
 "strings"
 "time"
 "filesmanage/internal/application"
 "github.com/gin-gonic/gin"
)

// A single bounded ZIP response prevents browser multi-download restrictions.
// The entire selection is authorized BEFORE status 200 or ZIP bytes are sent.
func(h *Handler) downloadFilesZip(c *gin.Context){
 u,ok:=h.auth(c);if !ok{return}
 raw:=c.Query("ids")
 if len(raw)>4096||raw==""{respondError(c,fmt.Errorf("%w: ids",domain.ErrInvalidInput));return}
 ids:=strings.Split(raw,",")
 files,cleanup,err:=h.S.OpenDownloadBatch(c.Request.Context(),u,ids)
 if err!=nil{respondError(c,err);return}
 defer cleanup()
 c.Header("Content-Type","application/zip")
 c.Header("Content-Disposition",contentDisposition("files-"+time.Now().UTC().Format("20060102-150405")+".zip"))
 c.Header("Cache-Control","private, no-store")
 c.Header("X-Content-Type-Options","nosniff")
 writer:=zip.NewWriter(c.Writer)
 for index,item:=range files{
  if c.Request.Context().Err()!=nil{return}
  entry,err:=writer.CreateHeader(&zip.FileHeader{Name:application.UniqueZipEntryName(item.FileName,index),Method:zip.Deflate,Modified:item.ModTime})
  if err!=nil{return}
  _,err=io.CopyN(entry,&cancelReader{ctx:c.Request.Context(),reader:item.Reader},item.Size)
  if err!=nil{return}
 }
 _=writer.Close()
}
type cancelReader struct{ctx context.Context;reader io.Reader}
func(r *cancelReader)Read(p []byte)(int,error){if err:=r.ctx.Err();err!=nil{return 0,err};return r.reader.Read(p)}
