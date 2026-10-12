package application

import (
	"context"
	"filesmanage/internal/domain"
	"strconv"
	"strings"
)

type DocumentAuditPage struct {
	Items      []domain.PermissionAuditRecord `json:"items"`
	NextCursor string                         `json:"nextCursor"`
}

func (s *Service) ListDocumentAudit(ctx context.Context, u domain.User, cursor string, limit int, fileID, actorID, eventPrefix string) (DocumentAuditPage, error) {
	page := DocumentAuditPage{Items: []domain.PermissionAuditRecord{}}
	if limit == 0 {
		limit = 30
	}
	if limit < 1 || limit > 100 || len(fileID) > 160 || len(actorID) > 160 || len(eventPrefix) > 48 {
		return page, domain.ErrInvalidInput
	}
	for _, r := range eventPrefix {
		if !(r >= 'a' && r <= 'z' || r == '.' || r == '_') {
			return page, domain.ErrInvalidInput
		}
	}
	var before int64
	if cursor != "" {
		parsed, err := strconv.ParseInt(cursor, 10, 64)
		if err != nil || parsed <= 0 {
			return page, domain.ErrInvalidInput
		}
		before = parsed
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return page, err
	}
	defer tx.Rollback(ctx)
	allowed, err := s.hasAuditPermission(ctx, tx, u)
	if err != nil {
		return page, err
	}
	if !allowed {
		return page, domain.ErrForbidden
	}
	rows, err := tx.ListDocumentAudit(ctx, domain.DocumentAuditFilter{BeforeID: before, Limit: limit + 1, FileID: strings.TrimSpace(fileID), ActorID: strings.TrimSpace(actorID), EventPrefix: eventPrefix})
	if err != nil {
		return page, err
	}
	if len(rows) > limit {
		rows = rows[:limit]
		page.NextCursor = strconv.FormatInt(rows[len(rows)-1].ID, 10)
	}
	if !u.IsAdmin {
		for i := range rows {
			rows[i].Details = minimalAuditDetails(rows[i].Details)
		}
	}
	page.Items = rows
	return page, nil
}

// FileHistory is scoped to one live file. A user with list access to the file
// can see its operation timeline without acquiring global auditor privileges.
// Deleted files remain accessible through the existing trash workflow only;
// global administrators may inspect them by stable file ID.
func (s *Service) FileHistory(ctx context.Context, u domain.User, fileID, cursor string, limit int) (DocumentAuditPage, error) {
	page := DocumentAuditPage{Items: []domain.PermissionAuditRecord{}}
	if fileID == "" || len(fileID) > 160 || limit < 1 || limit > 100 {
		return page, domain.ErrInvalidInput
	}
	var before int64
	if cursor != "" {
		parsed, err := strconv.ParseInt(cursor, 10, 64)
		if err != nil || parsed <= 0 {
			return page, domain.ErrInvalidInput
		}
		before = parsed
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return page, err
	}
	defer tx.Rollback(ctx)
	if u.IsAdmin {
		if _, err = tx.FileByID(ctx, fileID); err != nil {
			return page, domain.ErrNotFound
		}
	} else if _, err = s.visibleFile(ctx, tx, u, fileID, domain.ActionList); err != nil {
		// Do not disclose whether the inaccessible file exists.
		return page, domain.ErrNotFound
	}
	rows, err := tx.ListDocumentAudit(ctx, domain.DocumentAuditFilter{
		FileID: fileID, BeforeID: before, Limit: limit + 1,
	})
	if err != nil {
		return page, err
	}
	if len(rows) > limit {
		rows = rows[:limit]
		page.NextCursor = strconv.FormatInt(rows[len(rows)-1].ID, 10)
	}
	if !u.IsAdmin {
		// Previous folder paths, approval comments and seal ownership can
		// reveal information outside today's file-level authorization.
		// Expose only concise file-local state to regular viewers.
		allowed := map[string]bool{
			"name": true, "oldName": true, "newName": true,
			"baseSeq": true, "versionSeq": true, "targetSeq": true,
			"fromSeq": true, "size": true, "sha256": true,
		}
		for i := range rows {
			details := make(map[string]any)
			for k, v := range rows[i].Details {
				if allowed[k] {
					details[k] = v
				}
			}
			rows[i].Details = details
			rows[i].RequestID = ""
		}
	}
	page.Items = rows
	return page, nil
}
