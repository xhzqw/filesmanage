package application

import(
 "context"
 "errors"
 "filesmanage/internal/domain"
 "filesmanage/internal/ports"
)

func(s *Service) DHFPilotAttestationInbox(ctx context.Context,actor domain.User)([]ports.DHFPilotAttestationInboxRow,error){
 if actor.ID==""{return nil,ErrUnauthorized}
 tx,err:=s.uow.Begin(ctx)
 if err!=nil{return nil,err}
 defer tx.Rollback(ctx)
 store,ok:=any(tx).(ports.DHFPilotAttestationInboxStore)
 if !ok{return nil,errors.New("DHF authenticated review inbox unavailable")}
 if err=store.DHFPilotBeginSnapshot(ctx);err!=nil{return nil,err}
 user,err:=tx.UserByID(ctx,actor.ID)
 if err!=nil||user.ID!=actor.ID||user.DisabledAt!=nil{return nil,ErrUnauthorized}
 return store.DHFPilotAttestationInboxForSigner(ctx,actor.ID,100)
}
