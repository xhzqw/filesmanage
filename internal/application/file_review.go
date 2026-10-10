package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strconv"
	"strings"
	"unicode/utf8"
)

type ReviewCommentPage struct {
	Items      []domain.FileReviewComment `json:"items"`
	NextCursor string                     `json:"nextCursor"`
}

func (s *Service) ReviewComments(ctx context.Context, u domain.User, fileID string, version int, cursor string, limit int) (ReviewCommentPage, error) {
	page := ReviewCommentPage{Items: []domain.FileReviewComment{}}
	if version < 1 {
		return page, domain.ErrInvalidInput
	}
	if limit == 0 {
		limit = 30
	}
	if limit < 1 || limit > 100 {
		return page, domain.ErrInvalidInput
	}
	var before int64
	if cursor != "" {
		n, err := strconv.ParseInt(cursor, 10, 64)
		if err != nil || n < 1 {
			return page, domain.ErrInvalidInput
		}
		before = n
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return page, err
	}
	defer tx.Rollback(ctx)
	if _, err = s.visibleFile(ctx, tx, u, fileID, domain.ActionPreview); err != nil {
		return page, err
	}
	if _, err = tx.VersionBySeq(ctx, fileID, version); err != nil {
		return page, domain.ErrNotFound
	}
	rows, err := tx.ReviewComments(ctx, fileID, version, before, limit+1)
	if err != nil {
		return page, err
	}
	if len(rows) > limit {
		rows = rows[:limit]
		page.NextCursor = strconv.FormatInt(rows[len(rows)-1].ID, 10)
	}
	page.Items = rows
	return page, nil
}
func (s *Service) AddReviewComment(ctx context.Context, u domain.User, fileID string, version int, line *int, body string) (domain.FileReviewComment, error) {
	body = strings.TrimSpace(body)
	if version < 1 || body == "" || !utf8.ValidString(body) || utf8.RuneCountInString(body) > 2000 || (line != nil && (*line < 1 || *line > 1000000)) {
		return domain.FileReviewComment{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.FileReviewComment{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = s.visibleFile(ctx, tx, u, fileID, domain.ActionPreview); err != nil {
		return domain.FileReviewComment{}, err
	}
	if _, err = tx.VersionBySeq(ctx, fileID, version); err != nil {
		return domain.FileReviewComment{}, domain.ErrNotFound
	}
	comment, err := tx.InsertReviewComment(ctx, domain.FileReviewComment{FileID: fileID, VersionSeq: version, LineNumber: line, Body: body, AuthorID: u.ID})
	if err != nil {
		return domain.FileReviewComment{}, err
	}
	if err = auditRequired(ctx, tx, u, "file.review_comment", "file", fileID, "success", map[string]any{"commentId": comment.ID, "versionSeq": version}); err != nil {
		return domain.FileReviewComment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.FileReviewComment{}, err
	}
	return comment, nil
}
func (s *Service) ResolveReviewComment(ctx context.Context, u domain.User, fileID string, id int64) error {
	if id < 1 {
		return domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionPreview)
	if err != nil {
		return err
	}
	comment, err := tx.ReviewCommentByID(ctx, id)
	if errors.Is(err, ports.ErrRowMissing) {
		return domain.ErrNotFound
	}
	if err != nil {
		return err
	}
	if comment.FileID != fileID {
		return domain.ErrNotFound
	}
	if comment.ResolvedAt != nil {
		return domain.ErrVersionConflict
	}
	if u.ID != comment.AuthorID && !u.IsAdmin {
		if err = s.require(ctx, tx, u, file.FolderID, domain.ActionModify); err != nil {
			return err
		}
	}
	won, err := tx.ResolveReviewComment(ctx, id, u.ID)
	if err != nil {
		return err
	}
	if !won {
		return domain.ErrVersionConflict
	}
	if err = auditRequired(ctx, tx, u, "file.review_resolve", "file", fileID, "success", map[string]any{"commentId": id, "versionSeq": comment.VersionSeq}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
