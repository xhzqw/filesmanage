package application

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"time"
)

// Cursor is opaque to clients, strictly validated, and bound to one scope via
// an explicit scope identifier to prevent using a favorite cursor for shares.
type collaborationCursorToken struct {
	Version   int       `json:"v"`
	Scope     string    `json:"s"`
	CreatedAt time.Time `json:"t"`
	ID        string    `json:"id"`
}

const collaborationDefaultPage = 50
const collaborationMaxPage = 100

func collaborationLimit(limit int) int {
	if limit <= 0 {
		return collaborationDefaultPage
	}
	if limit > collaborationMaxPage {
		return collaborationMaxPage
	}
	return limit
}
func decodeCollaborationCursor(raw, scope string) (ports.CollaborationCursor, error) {
	if raw == "" {
		return ports.CollaborationCursor{}, nil
	}
	if len(raw) > 512 {
		return ports.CollaborationCursor{}, domain.ErrInvalidInput
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return ports.CollaborationCursor{}, domain.ErrInvalidInput
	}
	var t collaborationCursorToken
	if json.Unmarshal(b, &t) != nil || t.Version != 1 || t.Scope != scope || strings.TrimSpace(t.ID) == "" || len(t.ID) > 150 || t.CreatedAt.IsZero() {
		return ports.CollaborationCursor{}, domain.ErrInvalidInput
	}
	return ports.CollaborationCursor{CreatedAt: t.CreatedAt, ID: t.ID}, nil
}
func encodeCollaborationCursor(scope string, created time.Time, id string) string {
	b, _ := json.Marshal(collaborationCursorToken{Version: 1, Scope: scope, CreatedAt: created, ID: id})
	return base64.RawURLEncoding.EncodeToString(b)
}

type SharePage struct {
	Items      []domain.Share
	NextCursor string
}
type FavoritePage struct {
	Items      []domain.Favorite
	NextCursor string
}

func (s *Service) ListSharesPage(ctx context.Context, u domain.User, scope, raw string, limit int) (SharePage, error) {
	page := SharePage{Items: []domain.Share{}}
	after, err := decodeCollaborationCursor(raw, "shares:"+scope)
	if err != nil {
		return page, err
	}
	limit = collaborationLimit(limit)
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return page, err
	}
	defer tx.Rollback(ctx)
	var rows []domain.Share
	switch scope {
	case "received":
		groups, e := tx.WorkgroupsOf(ctx, u.ID)
		if e != nil {
			return page, e
		}
		rows, err = tx.PageSharesForSubject(ctx, u.ID, groups, after, limit+1)
	case "sent":
		if !u.IsAdmin {
			return page, domain.ErrForbidden
		}
		rows, err = tx.PageSharesCreatedBy(ctx, u.ID, after, limit+1)
	default:
		return page, domain.ErrInvalidInput
	}
	if err != nil {
		return page, err
	}
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		page.NextCursor = encodeCollaborationCursor("shares:"+scope, last.CreatedAt, last.ID)
	}
	page.Items = rows
	return page, nil
}
func (s *Service) ListFavoritesPage(ctx context.Context, u domain.User, raw string, limit int) (FavoritePage, error) {
	page := FavoritePage{Items: []domain.Favorite{}}
	after, err := decodeCollaborationCursor(raw, "favorites")
	if err != nil {
		return page, err
	}
	limit = collaborationLimit(limit)
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return page, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.PageFavorites(ctx, u.ID, after, limit+1)
	if err != nil {
		return page, err
	}
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		page.NextCursor = encodeCollaborationCursor("favorites", last.CreatedAt, last.ID)
	}
	if err = s.markUnavailableFavorites(ctx, tx, u, rows); err != nil {
		return FavoritePage{}, err
	}
	page.Items = rows
	return page, nil
}

// Only the caller's own favorite IDs survive invalidation; unreadable resource
// names are masked, but cleanup remains possible through the stored ID.
func (s *Service) markUnavailableFavorites(ctx context.Context, tx ports.Repository, u domain.User, rows []domain.Favorite) error {
	for i := range rows {
		f := &rows[i]
		if f.Unavailable {
			f.ResourceName = "不可访问的资源"
			continue
		}
		var err error
		if f.FileID != nil {
			_, err = s.visibleFile(ctx, tx, u, *f.FileID, domain.ActionPreview)
		} else if f.FolderID != nil {
			var folder domain.Folder
			folder, err = s.activeFolder(ctx, tx, *f.FolderID)
			if err == nil {
				err = s.require(ctx, tx, u, folder.ID, domain.ActionList)
			}
		} else {
			err = domain.ErrNotFound
		}
		if err == nil {
			continue
		}
		if errors.Is(err, domain.ErrForbidden) || errors.Is(err, domain.ErrNotFound) || errors.Is(err, ports.ErrRowMissing) {
			f.Unavailable = true
			f.ResourceName = "不可访问的资源"
		} else {
			return err
		}
	}
	return nil
}
