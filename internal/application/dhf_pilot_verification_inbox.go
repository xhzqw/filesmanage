package application

import(
 "context"
 "errors"
 "filesmanage/internal/domain"
 "filesmanage/internal/ports"
)

// Read-only correction status never grants access to the original file Blob.
func(s *Service)DHFPilotVerificationInbox(ctx context.Context,actor domain.User)([]ports.DHFPilotVerificationInboxRow,error){
 if actor.ID==""{return nil,ErrUnauthorized}
 tx,err:=s.uow.Begin(ctx)
 if err!=nil{return nil,err}
 defer tx.Rollback(ctx)
 store,ok:=any(tx).(ports.DHFPilotVerificationInboxStore)
 if !ok{return nil,errors.New("DHF verification inbox adapter unavailable")}
 if err=store.DHFPilotBeginSnapshot(ctx);err!=nil{return nil,err}
 user,err:=tx.UserByID(ctx,actor.ID)
 if err!=nil||user.ID!=actor.ID||user.DisabledAt!=nil{return nil,ErrUnauthorized}
 return store.DHFPilotVerificationCasesForReviewer(ctx,actor.ID,100)
}
