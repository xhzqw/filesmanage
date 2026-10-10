package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"time"
)

func (r *memoryRepo) CreateResumableUpload(_ context.Context, u domain.ResumableUpload) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, v := range r.resumableUploads {
		if v.OwnerID == u.OwnerID && v.OperationKey == u.OperationKey {
			return domain.ErrVersionConflict
		}
	}
	count := 0
	var reserved int64
	for _, v := range r.resumableUploads {
		if v.OwnerID == u.OwnerID && v.State == "open" && v.ExpiresAt.After(time.Now()) {
			count++
			reserved += v.ExpectedSize
		}
	}
	if count >= 3 || reserved+u.ExpectedSize > 2*int64(1<<30) {
		return domain.ErrInvalidInput
	}
	if r.resumableUploads == nil {
		r.resumableUploads = map[string]domain.ResumableUpload{}
	}
	u.ExpiresAt = time.Now().Add(24 * time.Hour)
	r.resumableUploads[u.ID] = u
	return nil
}
func (r *memoryRepo) ResumableUploadByID(_ context.Context, id, owner string) (domain.ResumableUpload, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	u, ok := r.resumableUploads[id]
	if !ok || u.OwnerID != owner {
		return domain.ResumableUpload{}, ports.ErrRowMissing
	}
	return u, nil
}
func (r *memoryRepo) ResumableUploadByOperation(_ context.Context, owner, key string) (domain.ResumableUpload, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, u := range r.resumableUploads {
		if u.OwnerID == owner && u.OperationKey == key {
			return u, nil
		}
	}
	return domain.ResumableUpload{}, ports.ErrRowMissing
}
func (r *memoryRepo) UpdateResumableOffset(_ context.Context, id string, old, next int64) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	u, ok := r.resumableUploads[id]
	if !ok || u.State != "open" || u.Received != old {
		return false, nil
	}
	u.Received = next
	u.ExpiresAt = time.Now().Add(24 * time.Hour)
	r.resumableUploads[id] = u
	return true, nil
}
func (r *memoryRepo) FinishResumableUpload(_ context.Context, id string, result []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	u := r.resumableUploads[id]
	u.State = "committed"
	u.ResultJSON = result
	r.resumableUploads[id] = u
	return nil
}
func (r *memoryRepo) CancelResumableUpload(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	u := r.resumableUploads[id]
	u.State = "cancelled"
	r.resumableUploads[id] = u
	return nil
}
