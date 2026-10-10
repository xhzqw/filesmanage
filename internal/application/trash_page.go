package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"time"
)

// TrashPage applies filters before pagination, retaining repository visibility.
type TrashPage struct {
	Items   []domain.TrashEntry
	HasMore bool
}
type TrashFilters struct {
	Search, Kind, DeletedBy, Sort string
	From                          time.Time
	Offset, Limit                 int
}

func (s *Service) PageTrash(ctx context.Context, u domain.User, f TrashFilters) (TrashPage, error) {
	f.Search = strings.TrimSpace(f.Search)
	f.DeletedBy = strings.TrimSpace(f.DeletedBy)
	if len([]rune(f.Search)) > 120 || len([]rune(f.DeletedBy)) > 80 ||
		f.Offset < 0 || f.Offset > 100000 || f.Limit < 1 || f.Limit > 100 ||
		(f.Kind != "" && f.Kind != "all" && f.Kind != "file" && f.Kind != "folder") ||
		(f.Sort != "" && f.Sort != "recent" && f.Sort != "oldest" && f.Sort != "name") {
		return TrashPage{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return TrashPage{}, err
	}
	defer tx.Rollback(ctx)
	items, err := tx.PageTrashEntries(ctx, ports.TrashQuery{
		UserID: u.ID, Search: f.Search, Kind: f.Kind, DeletedBy: f.DeletedBy,
		Sort: f.Sort, From: f.From, Offset: f.Offset, Limit: f.Limit + 1,
	})
	if err != nil {
		return TrashPage{}, err
	}
	more := len(items) > f.Limit
	if more {
		items = items[:f.Limit]
	}
	return TrashPage{Items: items, HasMore: more}, nil
}
