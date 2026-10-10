package postgres
import (
 "context"
 "encoding/json"
 "filesmanage/internal/domain"
)
func(r *Repository) ListDocumentAudit(ctx context.Context,f domain.DocumentAuditFilter)([]domain.PermissionAuditRecord,error){
 rows,err:=r.Q.Query(ctx,`SELECT id,coalesce(actor_id,''),request_id,event_type,target_kind,target_id,outcome,details,created_at
 FROM audit_events WHERE ($1::bigint=0 OR id<$1)
 AND (target_kind IN ('file','trash') OR event_type LIKE 'office.%' OR event_type LIKE 'approval.%')
 AND ($2='' OR (target_kind='file' AND target_id=$2))
 AND ($3='' OR actor_id=$3)
 AND ($4='' OR event_type LIKE $4||'%')
 ORDER BY id DESC LIMIT $5`,f.BeforeID,f.FileID,f.ActorID,f.EventPrefix,f.Limit)
 if err!=nil{return nil,err};defer rows.Close()
 out:=make([]domain.PermissionAuditRecord,0,f.Limit)
 for rows.Next(){
  var row domain.PermissionAuditRecord;var details []byte
  if err=rows.Scan(&row.ID,&row.ActorID,&row.RequestID,&row.EventType,&row.TargetKind,&row.TargetID,&row.Outcome,&details,&row.CreatedAt);err!=nil{return nil,err}
  if err=json.Unmarshal(details,&row.Details);err!=nil{return nil,err}
  out=append(out,row)
 }
 return out,rows.Err()
}
