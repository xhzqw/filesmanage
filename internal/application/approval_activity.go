package application

import(
 "context"
 "filesmanage/internal/domain"
 "filesmanage/internal/ports"
)
func(s *Service) approvalEvent(ctx context.Context,tx ports.Repository,approval domain.Approval,actor domain.User,kind string,comment string,recipients ...string)error{
 return tx.RecordApprovalEvent(ctx,domain.ApprovalEvent{
  ApprovalID:approval.ID,ActorID:actor.ID,Kind:kind,StepIndex:approval.StepIndex,Comment:comment,
 },recipients)
}
// Notify only after the surrounding transaction has committed. The durable
// notification table remains authoritative if a client is disconnected.
func(s *Service) notifyApprovalChanges(users ...string){
 seen:=map[string]bool{}
 for _,id:=range users{
  if id==""||seen[id]{continue};seen[id]=true
  s.publishUserEvent(id,UserEvent{Type:"approval.changed"})
 }
}
func(s *Service) ApprovalHistory(ctx context.Context,actor domain.User,id string)([]domain.ApprovalEvent,error){
 tx,err:=s.uow.Begin(ctx);if err!=nil{return nil,err};defer tx.Rollback(ctx)
 a,err:=tx.ApprovalByID(ctx,id);if err!=nil{return nil,notFoundOr(err)}
 allowed:=actor.IsAdmin||actor.ID==a.RequesterID
 for _,approverID:=range a.ApproverChain{if actor.ID==approverID{allowed=true}}
 if !allowed{return nil,domain.ErrForbidden}
 return tx.ListApprovalEvents(ctx,id)
}
func(s *Service) ApprovalNotifications(ctx context.Context,actor domain.User)([]domain.ApprovalNotification,error){
 tx,err:=s.uow.Begin(ctx);if err!=nil{return nil,err};defer tx.Rollback(ctx)
 return tx.ListApprovalNotifications(ctx,actor.ID)
}
func(s *Service) ReadApprovalNotification(ctx context.Context,actor domain.User,id int64)error{
 if id<=0{return domain.ErrInvalidInput}
 tx,err:=s.uow.Begin(ctx);if err!=nil{return err};defer tx.Rollback(ctx)
 found,err:=tx.ReadApprovalNotification(ctx,actor.ID,id);if err!=nil{return err}
 if !found{return domain.ErrNotFound}
 return tx.Commit(ctx)
}
