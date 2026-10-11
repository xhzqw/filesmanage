package application

import(
 "context"
 "filesmanage/internal/domain"
 "filesmanage/internal/ports"
 "time"
)

type LifecycleLedgerPage struct{
 Items []domain.LifecycleLedgerRow `json:"items"`
 NextCursor string `json:"nextCursor"`
}

// Cursor scans stable file IDs; each candidate is independently checked with
// the same visibility rules as file preview, so revoked shares are not leaked.
func(s *Service)LifecycleLedger(ctx context.Context,u domain.User,cursor,state string,limit int)(LifecycleLedgerPage,error){
 if limit<=0||limit>50||(state!=""&&state!="released"&&state!="archived"){return LifecycleLedgerPage{},domain.ErrInvalidInput}
 tx,err:=s.uow.Begin(ctx);if err!=nil{return LifecycleLedgerPage{},err};defer tx.Rollback(ctx)
 candidates,err:=tx.ListLifecycleLedger(ctx,cursor,state,limit+1,s.now())
 if err!=nil{return LifecycleLedgerPage{},err}
 page:=LifecycleLedgerPage{Items:[]domain.LifecycleLedgerRow{}}
 hasMore:=len(candidates)>limit
 if hasMore{candidates=candidates[:limit]}
 for _,row:=range candidates{
  if _,e:=s.visibleFile(ctx,tx,u,row.FileID,domain.ActionList);e!=nil{continue}
  row.DueStatus=lifecycleDueStatus(row.DueAt,s.now())
  page.Items=append(page.Items,row)
 }
 if hasMore{page.NextCursor=candidates[len(candidates)-1].FileID}
 return page,nil
}
func(s *Service)LifecycleNotifications(ctx context.Context,u domain.User)([]domain.LifecycleNotification,error){
 tx,err:=s.uow.Begin(ctx);if err!=nil{return nil,err};defer tx.Rollback(ctx)
 rows,err:=tx.ListLifecycleNotifications(ctx,u.ID);if err!=nil{return nil,err}
 out:=make([]domain.LifecycleNotification,0,len(rows))
 for _,row:=range rows{
  if _,e:=s.visibleFile(ctx,tx,u,row.FileID,domain.ActionList);e==nil{out=append(out,row)}
 }
 return out,nil
}
func(s *Service)ReadLifecycleNotification(ctx context.Context,u domain.User,id int64)error{
 if id<=0{return domain.ErrInvalidInput}
 tx,err:=s.uow.Begin(ctx);if err!=nil{return err};defer tx.Rollback(ctx)
 found,err:=tx.ReadLifecycleNotification(ctx,u.ID,id)
 if err!=nil{return err};if !found{return domain.ErrNotFound}
 return tx.Commit(ctx)
}
var _ = ports.ErrRowMissing
var _ = time.Time{}
