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

// Admin/auditor-only, bounded keyset page of permission changes.
func (s *Service) ListPermissionAudit(ctx context.Context, actor domain.User, cursor string, limit int) (PermissionAuditPage, error) {
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
	allowed, err := s.hasAuditPermission(ctx, tx, actor)
	if err != nil {
		return PermissionAuditPage{}, err
	}
	if !allowed {
		return PermissionAuditPage{}, domain.ErrForbidden
	}
	rows, err := tx.ListPermissionAudit(ctx, before, limit+1)
	if err != nil {
		return PermissionAuditPage{}, err
	}
	page := PermissionAuditPage{Items: rows, NextCursor: ""}
	if len(rows) > limit {
		page.Items = rows[:limit]
		page.NextCursor = strconv.FormatInt(page.Items[limit-1].ID, 10)
	}
	if !actor.IsAdmin {
		for i := range page.Items {
			page.Items[i].Details = minimalAuditDetails(page.Items[i].Details)
		}
	}
	return page, nil
}

// Non-admin auditor projection: older events contain free-text fields.
var safeAuditKeys = map[string]bool{
	"before": true, "after": true, "reason": true, "grantId": true, "subjectKind": true,
	"subjectId": true, "actions": true, "userId": true, "groupId": true, "recipientId": true,
	"scopeOnly": true, "disabled": true, "role": true, "scopeKind": true, "scopeId": true,
	"roleBindingId": true, "allowedActions": true, "expiresAt": true, "folderId": true,
	"shareId": true, "resourceId": true, "resourceKind": true, "member": true,
	"recipientKind": true, "includeDescendants": true, "revoked": true,
	"isAdmin": true, "mustChangePassword": true, "sessionsRevoked": true,
}

func minimalAuditDetails(details map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range details {
		if !safeAuditKeys[k] {
			continue
		}
		if nested, ok := v.(map[string]any); ok {
			out[k] = minimalAuditDetails(nested)
		} else {
			out[k] = v
		}
	}
	return out
}
