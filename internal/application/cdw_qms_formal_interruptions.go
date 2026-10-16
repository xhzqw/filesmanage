package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

func (s *Service) CDWQMSFormalInterruptions(ctx context.Context, actor domain.User) ([]ports.CDWQMSFormalInterruption, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWFormalStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	items, err := store.CDWQMSFormalInterruptions(ctx, actor.ID, 100)
	if err != nil {
		return nil, err
	}
	out := make([]ports.CDWQMSFormalInterruption, 0, len(items))
	for _, item := range items {
		visible := true
		for _, fid := range []string{item.SubjectFileID, item.PolicyFileID} {
			if _, e := s.visibleFile(ctx, tx, actor, fid, domain.ActionPreview); e != nil {
				visible = false
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				break
			}
		}
		if visible {
			out = append(out, item)
		}
	}
	return out, nil
}
