package postgres
import("context";"errors";"filesmanage/internal/domain";"filesmanage/internal/ports";"github.com/jackc/pgx/v5")
func(r *Repository) CreateResumableUpload(ctx context.Context,u domain.ResumableUpload)error{
 // Serialize quota checks for this principal even across browser tabs.
 _,err:=r.Q.Exec(ctx,"SELECT pg_advisory_xact_lock(hashtext($1))",u.OwnerID)
 if err!=nil{return err}
 var count int64;var reserved int64
 err=r.Q.QueryRow(ctx,`SELECT count(*),coalesce(sum(expected_size),0) FROM resumable_uploads WHERE owner_id=$1 AND state='open' AND expires_at>now()`,u.OwnerID).Scan(&count,&reserved)
 if err!=nil{return err}
 if count>=3||reserved+u.ExpectedSize>2*int64(1<<30){return domain.ErrInvalidInput}
 _,err:=r.Q.Exec(ctx,`INSERT INTO resumable_uploads(id,owner_id,folder_id,file_name,content_type,expected_size,expected_sha256,operation_key)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,u.ID,u.OwnerID,u.FolderID,u.FileName,u.ContentType,u.ExpectedSize,u.ExpectedSHA256,u.OperationKey)
 if isUniqueViolation(err){return domain.ErrVersionConflict}
 return err
}
const resumableFields=`SELECT id,owner_id,folder_id,file_name,content_type,expected_size,expected_sha256,operation_key,received_bytes,state,result_json,expires_at FROM resumable_uploads`
func scanResumable(row rowScanner)(domain.ResumableUpload,error){
 var u domain.ResumableUpload
 err:=row.Scan(&u.ID,&u.OwnerID,&u.FolderID,&u.FileName,&u.ContentType,&u.ExpectedSize,&u.ExpectedSHA256,&u.OperationKey,&u.Received,&u.State,&u.ResultJSON,&u.ExpiresAt)
 if errors.Is(err,pgx.ErrNoRows){return u,ports.ErrRowMissing};return u,err
}
func(r *Repository) ResumableUploadByID(ctx context.Context,id,owner string)(domain.ResumableUpload,error){
 return scanResumable(r.Q.QueryRow(ctx,resumableFields+" WHERE id=$1 AND owner_id=$2 FOR UPDATE",id,owner))
}
func(r *Repository) ResumableUploadByOperation(ctx context.Context,owner,key string)(domain.ResumableUpload,error){
 return scanResumable(r.Q.QueryRow(ctx,resumableFields+" WHERE owner_id=$1 AND operation_key=$2 FOR UPDATE",owner,key))
}
func(r *Repository) UpdateResumableOffset(ctx context.Context,id string,old,next int64)(bool,error){
 tag,err:=r.Q.Exec(ctx,`UPDATE resumable_uploads SET received_bytes=$3,updated_at=now(),expires_at=now()+interval '24 hours'
 WHERE id=$1 AND state='open' AND received_bytes=$2 AND expires_at>now()`,id,old,next)
 if err!=nil{return false,err};return tag.RowsAffected()==1,nil
}
func(r *Repository) FinishResumableUpload(ctx context.Context,id string,result []byte)error{
 _,err:=r.Q.Exec(ctx,`UPDATE resumable_uploads SET state='committed',result_json=$2,updated_at=now() WHERE id=$1 AND state='open'`,id,result)
 return err
}
func(r *Repository) CancelResumableUpload(ctx context.Context,id string)error{
 _,err:=r.Q.Exec(ctx,"UPDATE resumable_uploads SET state='cancelled',updated_at=now() WHERE id=$1 AND state='open'",id)
 return err
}
func(r *Repository) PruneExpiredResumableUploads(ctx context.Context)(int64,error){
 tag,err:=r.Q.Exec(ctx,"DELETE FROM resumable_uploads WHERE expires_at < now()-interval '48 hours'")
 if err!=nil{return 0,err};return tag.RowsAffected(),nil
}
