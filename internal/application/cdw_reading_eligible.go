package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

func (s *Service) CDWReadingEligible(ctx context.Context, actor domain.User, targetID string) ([]ports.CDWReadingPerson, error) {
	if targetID == "" {
		return nil, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWReadingStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	target, err := store.CDWReadingTargetInfo(ctx, targetID, actor.ID)
	if err != nil {
		return nil, err
	}
	if target.State != "received" {
		return nil, domain.ErrConflict
	}
	if _, err = s.visibleFile(ctx, tx, actor, target.FileID, domain.ActionPreview); err != nil {
		return nil, err
	}
	people, err := store.CDWReadingEligible(ctx, targetID, actor.ID)
	if err != nil {
		return nil, err
	}
	result := []ports.CDWReadingPerson{}
	for _, p := range people {
		u, e := tx.UserByID(ctx, p.ID)
		if e == nil && u.DisabledAt == nil && u.DepartmentID == target.DepartmentID {
			if _, e = s.visibleFile(ctx, tx, u, target.FileID, domain.ActionPreview); e == nil {
				result = append(result, p)
			}
		}
	}
	return result, nil
}
