package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"unicode/utf8"
)

var finderColors = map[string]bool{"red": true, "orange": true, "yellow": true, "green": true, "blue": true, "purple": true, "gray": true}

func validFinderLabel(name, color string) bool {
	name = strings.TrimSpace(name)
	return name != "" && utf8.ValidString(name) && utf8.RuneCountInString(name) <= 40 && finderColors[color]
}

func (s *Service) FinderLabels(ctx context.Context, u domain.User) ([]domain.FinderLabel, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err = tx.SeedFinderLabels(ctx, u.ID); err != nil {
		return nil, err
	}
	labels, err := tx.ListFinderLabels(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return labels, nil
}
func (s *Service) CreateFinderLabel(ctx context.Context, u domain.User, name, color string) (domain.FinderLabel, error) {
	name = strings.TrimSpace(name)
	if !validFinderLabel(name, color) {
		return domain.FinderLabel{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.FinderLabel{}, err
	}
	defer tx.Rollback(ctx)
	if err = tx.SeedFinderLabels(ctx, u.ID); err != nil {
		return domain.FinderLabel{}, err
	}
	current, err := tx.ListFinderLabels(ctx, u.ID)
	if err != nil {
		return domain.FinderLabel{}, err
	}
	if len(current) >= 40 {
		return domain.FinderLabel{}, domain.ErrConflict
	}
	label := domain.FinderLabel{ID: NewID("label"), UserID: u.ID, Name: name, Color: color, SortOrder: 100}
	if err = tx.InsertFinderLabel(ctx, label); err != nil {
		return domain.FinderLabel{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.FinderLabel{}, err
	}
	return label, nil
}
func (s *Service) UpdateFinderLabel(ctx context.Context, u domain.User, id, name, color string) (domain.FinderLabel, error) {
	name = strings.TrimSpace(name)
	if id == "" || !validFinderLabel(name, color) {
		return domain.FinderLabel{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.FinderLabel{}, err
	}
	defer tx.Rollback(ctx)
	labels, err := tx.ListFinderLabels(ctx, u.ID)
	if err != nil {
		return domain.FinderLabel{}, err
	}
	var label *domain.FinderLabel
	for i := range labels {
		if labels[i].ID == id {
			label = &labels[i]
			break
		}
	}
	if label == nil {
		return domain.FinderLabel{}, domain.ErrNotFound
	}
	if label.IsDefault && label.Color != color {
		return domain.FinderLabel{}, domain.ErrInvalidInput
	}
	label.Name = name
	label.Color = color
	label.UserID = u.ID
	updated, err := tx.UpdateFinderLabel(ctx, *label)
	if err != nil {
		return domain.FinderLabel{}, err
	}
	if !updated {
		return domain.FinderLabel{}, domain.ErrNotFound
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.FinderLabel{}, err
	}
	return *label, nil
}
func (s *Service) RemoveFinderLabel(ctx context.Context, u domain.User, id string) error {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	labels, err := tx.ListFinderLabels(ctx, u.ID)
	if err != nil {
		return err
	}
	for _, l := range labels {
		if l.ID == id {
			if l.IsDefault {
				return domain.ErrConflict
			}
			deleted, err := tx.DeleteFinderLabel(ctx, u.ID, id)
			if err != nil {
				return err
			}
			if !deleted {
				return domain.ErrNotFound
			}
			return tx.Commit(ctx)
		}
	}
	return domain.ErrNotFound
}
func finderLabelIn(labels []domain.FinderLabel, id string) bool {
	for _, l := range labels {
		if l.ID == id {
			return true
		}
	}
	return false
}
func (s *Service) FinderFileLabels(ctx context.Context, u domain.User, fileID string) ([]string, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = s.visibleFile(ctx, tx, u, fileID, domain.ActionList); err != nil {
		return nil, err
	}
	return tx.FinderFileLabelIDs(ctx, u.ID, fileID)
}
func (s *Service) FinderAssignments(ctx context.Context, u domain.User, fileIDs []string) (map[string][]string, error) {
	if len(fileIDs) > 100 {
		return nil, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	result := make(map[string][]string, len(fileIDs))
	for _, fileID := range fileIDs {
		if fileID == "" {
			return nil, domain.ErrInvalidInput
		}
		if _, exists := result[fileID]; exists {
			return nil, domain.ErrInvalidInput
		}
		if _, err = s.visibleFile(ctx, tx, u, fileID, domain.ActionList); err != nil {
			return nil, err
		}
		ids, e := tx.FinderFileLabelIDs(ctx, u.ID, fileID)
		if e != nil {
			return nil, e
		}
		result[fileID] = ids
	}
	return result, nil
}

// An assignment is a personal categorization, not a document mutation; LIST permission
// suffices, but every target is checked before the first write to keep batches atomic.
func (s *Service) SetFinderFiles(ctx context.Context, u domain.User, labelID string, fileIDs []string, add bool) error {
	if labelID == "" || len(fileIDs) == 0 || len(fileIDs) > 100 {
		return domain.ErrInvalidInput
	}
	seen := map[string]bool{}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	labels, err := tx.ListFinderLabels(ctx, u.ID)
	if err != nil {
		return err
	}
	if !finderLabelIn(labels, labelID) {
		return domain.ErrNotFound
	}
	for _, id := range fileIDs {
		if id == "" || seen[id] {
			return domain.ErrInvalidInput
		}
		seen[id] = true
		if _, err = s.visibleFile(ctx, tx, u, id, domain.ActionList); err != nil {
			return err
		}
	}
	for _, id := range fileIDs {
		if err = tx.SetFinderFileLabel(ctx, labelID, id, add); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Only authorized, non-deleted files are returned; labels never widen ACLs.
func (s *Service) FinderTaggedFiles(ctx context.Context, u domain.User, labelID string) ([]domain.File, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	labels, err := tx.ListFinderLabels(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	if !finderLabelIn(labels, labelID) {
		return nil, domain.ErrNotFound
	}
	ids, err := tx.FinderLabelFileIDs(ctx, u.ID, labelID)
	if errors.Is(err, ports.ErrRowMissing) {
		return nil, domain.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	result := make([]domain.File, 0, len(ids))
	for _, id := range ids {
		file, e := s.visibleFile(ctx, tx, u, id, domain.ActionList)
		if e == nil {
			result = append(result, file)
		} else if !errors.Is(e, domain.ErrForbidden) && !errors.Is(e, domain.ErrNotFound) {
			return nil, e
		}
	}
	return result, nil
}
