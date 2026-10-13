package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

func (s *Service) FavoriteNotifications(ctx context.Context, u domain.User) ([]domain.FavoriteNotification, int, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, 0, err
	}
	defer tx.Rollback(ctx)
	return tx.ListFavoriteNotifications(ctx, u.ID, 50)
}

func (s *Service) ReadFavoriteNotification(ctx context.Context, u domain.User, id int64) error {
	if id <= 0 {
		return domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = tx.ReadFavoriteNotification(ctx, u.ID, id); err != nil {
		if errors.Is(err, ports.ErrRowMissing) {
			return domain.ErrNotFound
		}
		return err
	}
	return tx.Commit(ctx)
}
