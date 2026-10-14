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

// FileHistory uses live-file list ACL, or the narrowly scoped right to access
// the file through an active (including ancestor folder) trash entry.
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
	file, err := tx.FileByID(ctx, fileID)
	if err != nil {
		return page, domain.ErrNotFound
	}
	if !u.IsAdmin {
		if file.DeletedAt != nil {
			allowed, accessErr := tx.TrashHistoryAccessible(ctx, fileID, u.ID)
			if accessErr != nil {
				return page, accessErr
			}
			if !allowed {
				return page, domain.ErrNotFound
			}
		} else if _, err = s.visibleFile(ctx, tx, u, fileID, domain.ActionList); err != nil {
			return page, domain.ErrNotFound
		}
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
			// The previous location may be outside the current ACL.
			// Distinguish withheld data from a genuinely missing old snapshot.
			if _, hasPath := rows[i].Details["fromPath"]; hasPath {
				details["pathRestricted"] = true
			}
			rows[i].Details = details
			rows[i].RequestID = ""
		}
	}
	page.Items = rows
	return page, nil
}
