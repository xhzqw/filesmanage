package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

func (s *Service) CDWDistributionLedger(ctx context.Context, actor domain.User, planID string) (ports.CDWDistributionLedger, error) {
	var out ports.CDWDistributionLedger
	if planID == "" {
		return out, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWDistributionStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	fileID, err := store.CDWDistributionPlanFile(ctx, planID)
	if err != nil {
		return out, err
	}
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return out, err
	}
	roles, ok := tx.(ports.CDWControlStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	if _, err = roles.CDWControlRole(ctx, actor.ID, "document_control", fileID); err != nil {
		return out, err
	}
	return store.CDWDistributionLedger(ctx, planID)
}
