package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"time"
)

func (r *memoryRepo) ListRoleBindings(context.Context) ([]domain.ManagementRoleBinding, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.ManagementRoleBinding, 0)
	for _, b := range r.roleBindings {
		if b.RevokedAt == nil {
			out = append(out, b)
		}
	}
	return out, nil
}
func (r *memoryRepo) RoleBindingsForUser(_ context.Context, userID string) ([]domain.ManagementRoleBinding, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.ManagementRoleBinding, 0)
	for _, b := range r.roleBindings {
		if b.UserID == userID && b.RevokedAt == nil {
			out = append(out, b)
		}
	}
	return out, nil
}
func (r *memoryRepo) RoleBindingByID(_ context.Context, id string) (domain.ManagementRoleBinding, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, ok := r.roleBindings[id]
	if !ok || b.RevokedAt != nil {
		return domain.ManagementRoleBinding{}, ports.ErrRowMissing
	}
	return b, nil
}
func (r *memoryRepo) InsertRoleBinding(_ context.Context, b domain.ManagementRoleBinding) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.roleBindings[b.ID]; ok {
		return domain.ErrConflict
	}
	b.CreatedAt = time.Now()
	r.roleBindings[b.ID] = b
	return nil
}
func (r *memoryRepo) RevokeRoleBinding(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, ok := r.roleBindings[id]
	if !ok || b.RevokedAt != nil {
		return ports.ErrRowMissing
	}
	now := time.Now()
	b.RevokedAt = &now
	r.roleBindings[id] = b
	return nil
}
