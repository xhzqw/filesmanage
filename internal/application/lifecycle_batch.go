package application
import(
 "context"
 "errors"
 "filesmanage/internal/domain"
 "time"
)
type LifecycleBulkDueRequest struct{
 Items []struct{
  FileID string `json:"fileId"`
  ExpectedVersionSeq int `json:"expectedVersionSeq"`
 } `json:"items"`
 DueAt *time.Time `json:"dueAt"`
}
type LifecycleBulkDueResult struct{
 FileID string `json:"fileId"`
 Status string `json:"status"`
}
func(s *Service)BulkLifecycleDue(ctx context.Context,u domain.User,req LifecycleBulkDueRequest)([]LifecycleBulkDueResult,error){
 if len(req.Items)==0||len(req.Items)>20{return nil,domain.ErrInvalidInput}
 if req.DueAt!=nil&&(req.DueAt.Before(s.now().Add(-24*time.Hour))||req.DueAt.After(s.now().AddDate(20,0,0))){return nil,domain.ErrInvalidInput}
 seen:=map[string]bool{};for _,row:=range req.Items{
  if row.FileID==""||row.ExpectedVersionSeq<1||seen[row.FileID]{return nil,domain.ErrInvalidInput}
  seen[row.FileID]=true
 }
 results:=make([]LifecycleBulkDueResult,0,len(req.Items))
 for _,row:=range req.Items{
  _,err:=s.SetFileLifecycle(ctx,u,row.FileID,LifecycleDraft{Action:"set_due",ExpectedVersionSeq:row.ExpectedVersionSeq,DueAt:req.DueAt})
  status:="updated"
  switch {
  case errors.Is(err,domain.ErrForbidden),errors.Is(err,domain.ErrNotFound):status="unavailable"
  case errors.Is(err,domain.ErrVersionConflict):status="version_conflict"
  case errors.Is(err,domain.ErrConflict),errors.Is(err,domain.ErrLocked),errors.Is(err,domain.ErrApprovalPending):status="conflict"
  case errors.Is(err,domain.ErrInvalidInput):status="invalid"
  case err!=nil: return results,err
  }
  results=append(results,LifecycleBulkDueResult{FileID:row.FileID,Status:status})
 }
 return results,nil
}
func(s *Service)LifecycleStatistics(ctx context.Context,u domain.User)(domain.LifecycleStatistics,error){
 if !u.IsAdmin{return domain.LifecycleStatistics{},domain.ErrForbidden}
 tx,err:=s.uow.Begin(ctx);if err!=nil{return domain.LifecycleStatistics{},err};defer tx.Rollback(ctx)
 return tx.LifecycleStatistics(ctx,s.now())
}
func responsibleLifecycleUser(l domain.FileLifecycle)string{
 if l.ResponsibleID!=nil{return *l.ResponsibleID};return l.PublishedBy
}
