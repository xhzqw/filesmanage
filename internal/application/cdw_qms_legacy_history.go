package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

func (s *Service) CDWQMSLegacyHoldHistory(ctx context.Context, actor domain.User) ([]ports.CDWQMSLegacyHold, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWQMSG16Store)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	items, err := store.CDWQMSLegacyHoldHistory(ctx, actor.ID, 100)
	if err != nil {
		return nil, err
	}
	out := []ports.CDWQMSLegacyHold{}
	for _, item := range items {
		if _, e := s.visibleFile(ctx, tx, actor, item.FileID, domain.ActionPreview); e == nil {
			out = append(out, item)
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	return out, nil
}
