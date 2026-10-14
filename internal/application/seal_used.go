package application

import (
	"context"
	"filesmanage/internal/domain"
)

func (s *Service) UsedFileSeals(ctx context.Context, actor domain.User, fileID string) ([]string, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return nil, err
	}
	store, err := sealRepository(tx)
	if err != nil {
		return nil, err
	}
	return store.UsedSealAssetIDs(ctx, fileID)
}
