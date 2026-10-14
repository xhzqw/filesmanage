package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
)

func ownSessionStore(tx ports.Tx) (ports.SessionInventory, error) {
	store, ok := tx.(ports.SessionInventory)
	if !ok {
		return nil, errors.New("session inventory repository is unavailable")
	}
	return store, nil
}

func (s *Service) ListMySessions(ctx context.Context, token string) ([]ports.SessionRow, error) {
	a, err := s.Session(ctx, token)
	if err != nil {
		return nil, err
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, err := ownSessionStore(tx)
	if err != nil {
		return nil, err
	}
	hash := HashToken(token)
	_ = store.TouchSession(ctx, hash) // Last-seen is best effort, with DB 60s throttle.
	items, err := store.ListOwnSessions(ctx, a.User.ID, hash)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	currentID := hash[:24]
	result := make([]ports.SessionRow, 0, len(items))
	for _, item := range items {
		if !item.ExpiresAt.After(s.now()) {
			continue
		}
		item.Current = item.ID == currentID
		result = append(result, item)
	}
	return result, nil
}

func (s *Service) ListMyAuthActivity(ctx context.Context, token string) ([]ports.AuthActivity, error) {
	a, err := s.Session(ctx, token)
	if err != nil {
		return nil, err
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, err := ownSessionStore(tx)
	if err != nil {
		return nil, err
	}
	return store.ListOwnAuthActivity(ctx, a.User.ID)
}

func (s *Service) TouchActiveSession(ctx context.Context, token string) {
	if len(token) != 43 {
		return
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	store, err := ownSessionStore(tx)
	if err != nil {
		return
	}
	if err = store.TouchSession(ctx, HashToken(token)); err == nil {
		_ = tx.Commit(ctx)
	}
}

// RevokeMySession never accepts a bearer token as a device identifier. The
// public ID is only a 96-bit hash prefix; ownership is enforced in SQL.
func (s *Service) RevokeMySession(ctx context.Context, token, id string) error {
	a, err := s.Session(ctx, token)
	if err != nil {
		return err
	}
	if len(id) != 24 || strings.Trim(id, "0123456789abcdef") != "" {
		return ports.ErrRowMissing
	}
	currentHash := HashToken(token)
	if id == currentHash[:24] {
		return ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	store, err := ownSessionStore(tx)
	if err != nil {
		return err
	}
	found, err := store.RevokeOwnSession(ctx, a.User.ID, id, currentHash)
	if err != nil {
		return err
	}
	if !found {
		return ports.ErrRowMissing
	}
	if err = auditRequired(ctx, tx, a.User, "auth.session_revoke", "session", id, "success", map[string]any{}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.bumpACLEpoch()
	s.session.dropUser(a.User.ID)
	s.notifySessionChange(a.User.ID)
	return nil
}
func (s *Service) RevokeOtherMySessions(ctx context.Context, token string) (int64, error) {
	a, err := s.Session(ctx, token)
	if err != nil {
		return 0, err
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	store, err := ownSessionStore(tx)
	if err != nil {
		return 0, err
	}
	count, err := store.RevokeOtherSessions(ctx, a.User.ID, HashToken(token))
	if err != nil {
		return 0, err
	}
	if err = auditRequired(ctx, tx, domain.User{ID: a.User.ID}, "auth.sessions_revoke", "user", a.User.ID, "success", map[string]any{"count": count}); err != nil {
		return 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	s.bumpACLEpoch()
	s.session.dropUser(a.User.ID)
	s.notifySessionChange(a.User.ID)
	return count, nil
}
