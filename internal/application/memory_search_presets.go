package application

import (
	"context"
	"filesmanage/internal/domain"
	"sort"
	"time"
)

func (r *memoryRepo) ListSearchPresets(ctx context.Context, user string) ([]domain.SearchPreset, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([]domain.SearchPreset, 0)
	for _, p := range r.searchPresets[user] {
		result = append(result, p)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}
func (r *memoryRepo) UpsertSearchPreset(ctx context.Context, user string, p domain.SearchPreset) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.searchPresets[user] == nil {
		r.searchPresets[user] = map[string]domain.SearchPreset{}
	}
	if len(r.searchPresets[user]) >= 12 {
		if _, exists := r.searchPresets[user][p.Name]; !exists {
			return false, nil
		}
	}
	p.CreatedAt = time.Now()
	r.searchPresets[user][p.Name] = p
	return true, nil
}
func (r *memoryRepo) DeleteSearchPreset(ctx context.Context, user, name string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.searchPresets[user][name]; !ok {
		return false, nil
	}
	delete(r.searchPresets[user], name)
	return true, nil
}
