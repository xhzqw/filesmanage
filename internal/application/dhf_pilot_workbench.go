package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

// DHFPilotWorkbenchInbox presents outstanding professional/Gate work inside
// the existing Workbench. Tasks are trial-only until formal signing is built.
func (s *Service) DHFPilotWorkbenchInbox(ctx context.Context, actor domain.User) ([]ports.DHFPilotWorkbenchTask,error) {
	if actor.ID=="" {return nil,ErrUnauthorized}
	tx,err:=s.uow.Begin(ctx)
	if err!=nil{return nil,err}
	defer tx.Rollback(ctx)
	store,ok:=any(tx).(ports.DHFPilotWorkbenchStore)
	if !ok {return nil,errors.New("DHF review inbox adapter unavailable")}
	if err=store.DHFPilotBeginSnapshot(ctx);err!=nil{return nil,err}
	trusted,err:=tx.UserByID(ctx,actor.ID)
	if err!=nil || trusted.ID!=actor.ID || trusted.DisabledAt!=nil {
		return nil,ErrUnauthorized
	}
	return store.DHFPilotReviewTasksForActor(ctx,actor.ID,100)
}
