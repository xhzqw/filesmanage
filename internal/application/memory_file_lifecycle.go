package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

func (r *memoryRepo) FileLifecycleByID(_ context.Context, id string) (domain.FileLifecycle, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	value, ok := r.lifecycle[id]
	if !ok {
		return domain.FileLifecycle{}, ports.ErrRowMissing
	}
	return value, nil
}
func (r *memoryRepo) UpsertFileLifecycle(_ context.Context, value domain.FileLifecycle) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.lifecycle == nil {
		r.lifecycle = map[string]domain.FileLifecycle{}
	}
	r.lifecycle[value.FileID] = value
	return nil
}
