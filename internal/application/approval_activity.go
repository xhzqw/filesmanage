package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

func (s *Service) approvalEvent(ctx context.Context, tx ports.Repository, approval domain.Approval, actor domain.User, kind string, comment string, recipients ...string) error {
	return tx.RecordApprovalEvent(ctx, domain.ApprovalEvent{
		ApprovalID: approval.ID, ActorID: actor.ID, Kind: kind, StepIndex: approval.StepIndex, Comment: comment,
	}, recipients)
}

// Notify only after the surrounding transaction has committed. The durable
// notification table remains authoritative if a client is disconnected.
func (s *Service) notifyApprovalChanges(users ...string) {
	// A final approval may have committed a new immutable file version; pending
	// and terminal decisions also update workflow-facing read models.
	s.notifyWorkspaceChange("file", "review", "stats")
	seen := map[string]bool{}
	for _, id := range users {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		s.publishUserEvent(id, UserEvent{Type: "approval.changed"})
	}
}

// A participant may inspect the record even after the approval leaves their inbox.
// Draft bytes retain the stricter pending-state and file-permission checks.
func approvalParticipant(actor domain.User, a domain.Approval) bool {
	if actor.IsAdmin || actor.ID == a.RequesterID {
		return true
	}
	for _, member := range a.ApproverChain {
		if actor.ID == member {
			return true
		}
	}
	return false
}

func (s *Service) ApprovalDetail(ctx context.Context, actor domain.User, id string) (domain.Approval, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.Approval{}, err
	}
	defer tx.Rollback(ctx)
	a, err := tx.ApprovalByID(ctx, id)
	if err != nil {
		return domain.Approval{}, notFoundOr(err)
	}
	if !approvalParticipant(actor, a) {
		return domain.Approval{}, domain.ErrForbidden
	}
	return a, nil
}

func (s *Service) ApprovalHistory(ctx context.Context, actor domain.User, id string) ([]domain.ApprovalEvent, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	a, err := tx.ApprovalByID(ctx, id)
	if err != nil {
		return nil, notFoundOr(err)
	}
	if !approvalParticipant(actor, a) {
		return nil, domain.ErrForbidden
	}
	return tx.ListApprovalEvents(ctx, id)
}
func (s *Service) ApprovalNotifications(ctx context.Context, actor domain.User) ([]domain.ApprovalNotification, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	return tx.ListApprovalNotifications(ctx, actor.ID)
}
func (s *Service) ReadApprovalNotification(ctx context.Context, actor domain.User, id int64) error {
	if id <= 0 {
		return domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	found, err := tx.ReadApprovalNotification(ctx, actor.ID, id)
	if err != nil {
		return err
	}
	if !found {
		return domain.ErrNotFound
	}
	return tx.Commit(ctx)
}
