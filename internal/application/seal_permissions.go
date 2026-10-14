package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

// These permissions are independent of document ACLs and seal-specific grants.
func (s *Service) MySealPermission(ctx context.Context, u domain.User) (domain.SealUserPermission, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.SealUserPermission{}, err
	}
	defer tx.Rollback(ctx)
	store, err := sealRepository(tx)
	if err != nil {
		return domain.SealUserPermission{}, err
	}
	v, err := store.SealUserPermission(ctx, u.ID)
	return v, notFoundOr(err)
}
func (s *Service) SealPermissions(ctx context.Context, u domain.User) ([]domain.SealUserPermission, error) {
	if !u.IsAdmin {
		return nil, domain.ErrForbidden
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, err := sealRepository(tx)
	if err != nil {
		return nil, err
	}
	return store.ListSealUserPermissions(ctx)
}
func (s *Service) UpdateSealPermission(ctx context.Context, u domain.User, userID string, canSign, canStamp bool) error {
	if !u.IsAdmin {
		return domain.ErrForbidden
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	store, err := sealRepository(tx)
	if err != nil {
		return err
	}
	old, err := store.SealUserPermission(ctx, userID)
	if err != nil {
		return notFoundOr(err)
	}
	if err = store.SetSealUserPermission(ctx, userID, canSign, canStamp, u.ID); err != nil {
		return err
	}
	if err = auditRequired(ctx, tx, u, "seal.permission_update", "user", userID, "success", map[string]any{
		"before": map[string]any{"canSign": old.CanSign, "canStamp": old.CanStamp},
		"after":  map[string]any{"canSign": canSign, "canStamp": canStamp},
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

var _ ports.SealStore
