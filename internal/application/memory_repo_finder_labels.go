package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"sort"
)

// In-memory ports implementation is used by service unit tests.
func (r *memoryRepo) SeedFinderLabels(_ context.Context, user string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	names := []string{"红色", "橙色", "黄色", "绿色", "蓝色", "紫色", "灰色"}
	colors := []string{"red", "orange", "yellow", "green", "blue", "purple", "gray"}
	for i, color := range colors {
		id := "label_default_" + user + "_" + color
		if _, ok := r.finderLabels[id]; !ok {
			r.finderLabels[id] = domain.FinderLabel{ID: id, UserID: user, Name: names[i], Color: color, SortOrder: i, IsDefault: true}
		}
	}
	return nil
}
func (r *memoryRepo) ListFinderLabels(_ context.Context, user string) ([]domain.FinderLabel, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := []domain.FinderLabel{}
	for _, v := range r.finderLabels {
		if v.UserID == user {
			result = append(result, v)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].SortOrder != result[j].SortOrder {
			return result[i].SortOrder < result[j].SortOrder
		}
		return result[i].ID < result[j].ID
	})
	return result, nil
}
func (r *memoryRepo) InsertFinderLabel(_ context.Context, v domain.FinderLabel) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, old := range r.finderLabels {
		if old.UserID == v.UserID && old.Name == v.Name {
			return domain.ErrConflict
		}
	}
	r.finderLabels[v.ID] = v
	return nil
}
func (r *memoryRepo) UpdateFinderLabel(_ context.Context, v domain.FinderLabel) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	old, ok := r.finderLabels[v.ID]
	if !ok || old.UserID != v.UserID {
		return false, nil
	}
	for _, x := range r.finderLabels {
		if x.ID != v.ID && x.UserID == v.UserID && x.Name == v.Name {
			return false, domain.ErrConflict
		}
	}
	old.Name = v.Name
	old.Color = v.Color
	r.finderLabels[v.ID] = old
	return true, nil
}
func (r *memoryRepo) DeleteFinderLabel(_ context.Context, user, id string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.finderLabels[id]
	if !ok || v.UserID != user || v.IsDefault {
		return false, nil
	}
	delete(r.finderLabels, id)
	delete(r.finderAssignments, id)
	return true, nil
}
func (r *memoryRepo) FinderLabelFileIDs(_ context.Context, user, id string) ([]string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if v, ok := r.finderLabels[id]; !ok || v.UserID != user {
		return nil, ports.ErrRowMissing
	}
	ids := []string{}
	for fileID := range r.finderAssignments[id] {
		ids = append(ids, fileID)
	}
	return ids, nil
}
func (r *memoryRepo) FinderFileLabelIDs(_ context.Context, user, fileID string) ([]string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := []string{}
	for id, files := range r.finderAssignments {
		if v, ok := r.finderLabels[id]; ok && v.UserID == user && files[fileID] {
			result = append(result, id)
		}
	}
	return result, nil
}
func (r *memoryRepo) SetFinderFileLabel(_ context.Context, labelID, fileID string, add bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.finderAssignments[labelID] == nil {
		r.finderAssignments[labelID] = map[string]bool{}
	}
	if add {
		r.finderAssignments[labelID][fileID] = true
	} else {
		delete(r.finderAssignments[labelID], fileID)
	}
	return nil
}
