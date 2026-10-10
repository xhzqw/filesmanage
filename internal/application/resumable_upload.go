package application

import (
 "context"
 "crypto/sha256"
 "encoding/hex"
 "encoding/json"
 "errors"
 "filesmanage/internal/domain"
 "filesmanage/internal/ports"
 "io"
 "strings"
 "time"
)

const MaxResumableChunk=4<<20
const MaxResumableFile=int64(1<<30)
const resumableTTL=24*time.Hour

type ResumableUploadStatus struct{
 ID string `json:"id"`
 Received int64 `json:"received"`
 Size int64 `json:"size"`
 State string `json:"state"`
 ExpiresAt time.Time `json:"expiresAt"`
 Result *UploadResult `json:"result,omitempty"`
}
func resumableStatus(u domain.ResumableUpload)(ResumableUploadStatus,error){
 out:=ResumableUploadStatus{ID:u.ID,Received:u.Received,Size:u.ExpectedSize,State:u.State,ExpiresAt:u.ExpiresAt}
 if u.State=="committed"&&len(u.ResultJSON)>0{
  var result UploadResult
  if err:=json.Unmarshal(u.ResultJSON,&result);err!=nil{return out,err}
  out.Result=&result
 }
 return out,nil
}
func(s *Service) StartResumableUpload(ctx context.Context,actor domain.User,folderID,name,mime,key,digest string,size int64)(ResumableUploadStatus,error){
 empty:=ResumableUploadStatus{}
 name=strings.TrimSpace(name)
 if folderID==""||name==""||len(name)>200||size<1||size>MaxResumableFile||len(key)<8||len(key)>128||len(mime)>200{return empty,domain.ErrInvalidInput}
 if digest!=""{
  if len(digest)!=64{return empty,domain.ErrInvalidInput}
  if _,err:=hex.DecodeString(digest);err!=nil{return empty,domain.ErrInvalidInput}
  digest=strings.ToLower(digest)
 }
 tx,err:=s.uow.Begin(ctx);if err!=nil{return empty,err};defer tx.Rollback(ctx)
 folder,err:=s.activeFolder(ctx,tx,folderID);if err!=nil{return empty,err}
 if err=s.require(ctx,tx,actor,folder.ID,domain.ActionUpload);err!=nil{return empty,err}
 existing,err:=tx.ResumableUploadByOperation(ctx,actor.ID,key)
 if err==nil{
  if existing.FolderID!=folderID||existing.FileName!=name||existing.ExpectedSize!=size||existing.ExpectedSHA256!=digest||existing.ContentType!=mime{return empty,domain.ErrVersionConflict}
  if existing.State=="cancelled"||existing.ExpiresAt.Before(time.Now()){return empty,domain.ErrVersionConflict}
  return resumableStatus(existing)
 }
 if !isRowMissing(err){return empty,err}
 u:=domain.ResumableUpload{ID:NewID("upload"),OwnerID:actor.ID,FolderID:folderID,
  FileName:name,ContentType:mime,ExpectedSize:size,ExpectedSHA256:digest,OperationKey:key,
  State:"open",ExpiresAt:time.Now().Add(resumableTTL),
 }
 if err=tx.CreateResumableUpload(ctx,u);err!=nil{return empty,err}
 if err=tx.Commit(ctx);err!=nil{return empty,err}
 return resumableStatus(u)
}
func(s *Service) resumableTx(ctx context.Context,actor domain.User,id string)(ports.Tx,domain.ResumableUpload,error){
 tx,err:=s.uow.Begin(ctx);if err!=nil{return nil,domain.ResumableUpload{},err}
 u,err:=tx.ResumableUploadByID(ctx,id,actor.ID)
 if err!=nil{tx.Rollback(ctx);if isRowMissing(err){return nil,u,domain.ErrNotFound};return nil,u,err}
 if u.ExpiresAt.Before(time.Now())&&u.State=="open"{tx.Rollback(ctx);return nil,u,domain.ErrNotFound}
 folder,err:=s.activeFolder(ctx,tx,u.FolderID)
 if err!=nil{tx.Rollback(ctx);return nil,u,err}
 if err=s.require(ctx,tx,actor,folder.ID,domain.ActionUpload);err!=nil{tx.Rollback(ctx);return nil,u,err}
 return tx,u,nil
}
func(s *Service) ResumableStatus(ctx context.Context,actor domain.User,id string)(ResumableUploadStatus,error){
 tx,u,err:=s.resumableTx(ctx,actor,id);if err!=nil{return ResumableUploadStatus{},err};defer tx.Rollback(ctx)
 return resumableStatus(u)
}
func(s *Service) AppendResumableChunk(ctx context.Context,actor domain.User,id string,offset int64,data []byte,digest string)(ResumableUploadStatus,error){
 empty:=ResumableUploadStatus{}
 if offset<0||len(data)==0||len(data)>MaxResumableChunk||len(digest)!=64{return empty,domain.ErrInvalidInput}
 sum:=sha256.Sum256(data)
 if !strings.EqualFold(hex.EncodeToString(sum[:]),digest){return empty,domain.ErrInvalidInput}
 spool,ok:=s.blobs.(ports.ResumableBlobStore);if !ok{return empty,errors.New("resumable blob store unavailable")}
 tx,u,err:=s.resumableTx(ctx,actor,id);if err!=nil{return empty,err};defer tx.Rollback(ctx)
 if u.State!="open"||offset!=u.Received||int64(len(data))>u.ExpectedSize-offset{return empty,domain.ErrVersionConflict}
 if err=spool.AppendResumable(id,offset,data);err!=nil{return empty,err}
 next:=offset+int64(len(data))
 won,err:=tx.UpdateResumableOffset(ctx,id,offset,next);if err!=nil{return empty,err}
 if !won{return empty,domain.ErrVersionConflict}
 if err=tx.Commit(ctx);err!=nil{return empty,err}
 u.Received=next;u.ExpiresAt=time.Now().Add(resumableTTL)
 return resumableStatus(u)
}
func(s *Service) CompleteResumableUpload(ctx context.Context,actor domain.User,id string)(UploadResult,error){
 var empty UploadResult
 spool,ok:=s.blobs.(ports.ResumableBlobStore);if !ok{return empty,errors.New("resumable blob store unavailable")}
 tx,u,err:=s.resumableTx(ctx,actor,id);if err!=nil{return empty,err};defer tx.Rollback(ctx)
 if u.State=="committed"{
  var result UploadResult
  if err=json.Unmarshal(u.ResultJSON,&result);err!=nil{return empty,err}
  return result,nil
 }
 if u.State!="open"||u.Received!=u.ExpectedSize{return empty,domain.ErrVersionConflict}
 reader,size,err:=spool.OpenResumable(id);if err!=nil{return empty,err}
 if size!=u.ExpectedSize{reader.Close();return empty,domain.ErrVersionConflict}
 digest:=sha256.New()
 _,err=io.Copy(digest,reader);reader.Close();if err!=nil{return empty,err}
 if u.ExpectedSHA256!=""&&!strings.EqualFold(hex.EncodeToString(digest.Sum(nil)),u.ExpectedSHA256){return empty,domain.ErrVersionConflict}
 reader,_,err=spool.OpenResumable(id);if err!=nil{return empty,err}
 result,err:=s.CommitUpload(ctx,actor,u.FolderID,u.FileName,u.ContentType,u.OperationKey,reader)
 reader.Close()
 if err!=nil{return empty,err}
 bytes,err:=json.Marshal(result);if err!=nil{return empty,err}
 if err=tx.FinishResumableUpload(ctx,id,bytes);err!=nil{return empty,err}
 if err=tx.Commit(ctx);err!=nil{return empty,err}
 _=spool.RemoveResumable(id)
 return result,nil
}
func(s *Service) CancelResumableUpload(ctx context.Context,actor domain.User,id string)error{
 spool,ok:=s.blobs.(ports.ResumableBlobStore);if !ok{return errors.New("resumable blob store unavailable")}
 tx,u,err:=s.resumableTx(ctx,actor,id);if err!=nil{return err};defer tx.Rollback(ctx)
 if u.State=="committed"{return domain.ErrVersionConflict}
 if u.State=="cancelled"{return nil}
 if err=tx.CancelResumableUpload(ctx,id);err!=nil{return err}
 if err=tx.Commit(ctx);err!=nil{return err}
 _=spool.RemoveResumable(id)
 return nil
}
