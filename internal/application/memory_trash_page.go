package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"sort"
	"strings"
)

func (r *memoryRepo) PageTrashEntries(ctx context.Context, q ports.TrashQuery) ([]domain.TrashEntry, error) {
	if q.Limit < 1 || q.Limit > 101 || q.Offset < 0 || q.Offset > 100000 {
		return nil, domain.ErrInvalidInput
	}
	all, err := r.ListTrashEntries(ctx, q.UserID)
	if err != nil {
		return nil, err
	}
	items := make([]domain.TrashEntry, 0, len(all))
	for _, t := range all {
		if q.Search != "" && !strings.Contains(strings.ToLower(t.OldName), strings.ToLower(q.Search)) {
			continue
		}
		if q.Kind == "file" && t.FileID == nil {
			continue
		}
		if q.Kind == "folder" && t.FolderID == nil {
			continue
		}
		if q.DeletedBy != "" && !strings.Contains(strings.ToLower(t.DeletedName), strings.ToLower(q.DeletedBy)) {
			continue
		}
		if !q.From.IsZero() && t.DeletedAt.Before(q.From) {
			continue
		}
		items = append(items, t)
	}
	sort.Slice(items, func(i, j int) bool {
		a, b := items[i], items[j]
		switch q.Sort {
		case "name":
			x, y := strings.ToLower(a.OldName), strings.ToLower(b.OldName)
			if x != y {
				return x < y
			}
		case "oldest":
			if !a.DeletedAt.Equal(b.DeletedAt) {
				return a.DeletedAt.Before(b.DeletedAt)
			}
			return a.ID < b.ID
		default:
			if !a.DeletedAt.Equal(b.DeletedAt) {
				return a.DeletedAt.After(b.DeletedAt)
			}
			return a.ID > b.ID
		}
		return a.ID < b.ID
	})
	if q.Offset >= len(items) {
		return []domain.TrashEntry{}, nil
	}
	end := q.Offset + q.Limit
	if end > len(items) {
		end = len(items)
	}
	return items[q.Offset:end], nil
}
