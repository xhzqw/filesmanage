package application

import (
	"bytes"
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"strings"
	"unicode/utf8"
)

const searchPresetLimit = 12

var presetFields = map[string]bool{"q": true, "category": true, "tag": true, "uploader": true, "type": true, "sort": true, "limit": true, "scope": true, "folder": true, "from": true, "to": true}

func validPreset(name string, raw json.RawMessage) bool {
	if strings.TrimSpace(name) != name || name == "" || utf8.RuneCountInString(name) > 48 || len(raw) == 0 || len(raw) > 4096 {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var fields map[string]any
	if err := decoder.Decode(&fields); err != nil || len(fields) != len(presetFields) {
		return false
	}
	for key := range fields {
		if !presetFields[key] {
			return false
		}
	}
	for key, value := range fields {
		if key == "limit" {
			n, ok := value.(float64)
			if !ok || (n != 50 && n != 100 && n != 200) {
				return false
			}
			continue
		}
		str, ok := value.(string)
		if !ok || len(str) > 240 {
			return false
		}
		if key == "scope" && str != "all" && str != "current" && str != "descendants" {
			return false
		}
		if key == "sort" && str != "relevance" && str != "updated_desc" && str != "name_asc" && str != "size_desc" {
			return false
		}
	}
	return true
}
func (s *Service) ListSearchPresets(ctx context.Context, u domain.User) ([]domain.SearchPreset, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	return tx.ListSearchPresets(ctx, u.ID)
}
func (s *Service) SaveSearchPreset(ctx context.Context, u domain.User, p domain.SearchPreset) ([]domain.SearchPreset, error) {
	if !validPreset(p.Name, p.Fields) {
		return nil, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	ok, err := tx.UpsertSearchPreset(ctx, u.ID, p)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	if err = auditRequired(ctx, tx, u, "search.preset.save", "user", u.ID, "success", map[string]any{"name": p.Name}); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	// Search presets belong to one account; notify its other devices only.
	s.publishUserEvent(u.ID, UserEvent{Type: "workspace.changed", Scopes: []string{"search"}})
	return s.ListSearchPresets(ctx, u)
}
func (s *Service) RemoveSearchPreset(ctx context.Context, u domain.User, name string) error {
	if name == "" || utf8.RuneCountInString(name) > 48 {
		return domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	found, err := tx.DeleteSearchPreset(ctx, u.ID, name)
	if err != nil {
		return err
	}
	if !found {
		return domain.ErrNotFound
	}
	if err = auditRequired(ctx, tx, u, "search.preset.delete", "user", u.ID, "success", map[string]any{"name": name}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.publishUserEvent(u.ID, UserEvent{Type: "workspace.changed", Scopes: []string{"search"}})
	return nil
}
