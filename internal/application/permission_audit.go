package application

import (
	"context"
	"filesmanage/internal/domain"
	"strconv"
)

type PermissionAuditPage struct {
	Items      []domain.PermissionAuditRecord `json:"items"`
	NextCursor string                         `json:"nextCursor"`
}

// Admin-only, bounded keyset page of permission changes.
func (s *Service) ListPermissionAudit(ctx context.Context, actor domain.User, cursor string, limit int) (PermissionAuditPage, error) {
	if err := s.requireAdmin(actor); err != nil {
		return PermissionAuditPage{}, err
	}
	if limit == 0 {
		limit = 30
	}
	if limit < 1 || limit > 100 {
		return PermissionAuditPage{}, domain.ErrInvalidInput
	}
	var before int64
	if cursor != "" {
		value, err := strconv.ParseInt(cursor, 10, 64)
		if err != nil || value <= 0 {
			return PermissionAuditPage{}, domain.ErrInvalidInput
		}
		before = value
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return PermissionAuditPage{}, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.ListPermissionAudit(ctx, before, limit+1)
	if err != nil {
		return PermissionAuditPage{}, err
	}
	page := PermissionAuditPage{Items: rows, NextCursor: ""}
	if len(rows) > limit {
		page.Items = rows[:limit]
		page.NextCursor = strconv.FormatInt(page.Items[limit-1].ID, 10)
	}
	return page, nil
}
