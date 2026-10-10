package ports
import("context";"filesmanage/internal/domain";"io")
type ResumableUploadRepository interface {
 CreateResumableUpload(context.Context,domain.ResumableUpload)error
 ResumableUploadByID(context.Context,string,string)(domain.ResumableUpload,error)
 ResumableUploadByOperation(context.Context,string,string)(domain.ResumableUpload,error)
 UpdateResumableOffset(context.Context,string,int64,int64) (bool,error)
 FinishResumableUpload(context.Context,string,[]byte)error
 CancelResumableUpload(context.Context,string)error
}
type ResumableBlobStore interface{
 AppendResumable(string,int64,[]byte)error
 OpenResumable(string)(io.ReadCloser,int64,error)
 RemoveResumable(string)error
}
