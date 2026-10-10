package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

func (r *memoryRepo) RestoreFileTo(_ context.Context, id, folderID, name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	f, ok := r.files[id]
	if !ok || f.DeletedAt == nil {
		return ports.ErrRowMissing
	}
	for _, existing := range r.files {
		if existing.ID != id && existing.DeletedAt == nil && existing.FolderID == folderID && existing.Name == name {
			return domain.ErrNameConflict
		}
	}
	f.Name = name
	f.FolderID = folderID
	f.DeletedAt = nil
	r.files[id] = f
	return nil
}

func (r *memoryRepo) RestoreFolderTo(_ context.Context, id, parentID, name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	f, ok := r.folders[id]
	if !ok || f.DeletedAt == nil {
		return ports.ErrRowMissing
	}
	for _, existing := range r.folders {
		if existing.ID != id && existing.DeletedAt == nil && existing.ParentID != nil &&
			*existing.ParentID == parentID && existing.Name == name {
			return domain.ErrNameConflict
		}
	}
	f.Name = name
	f.ParentID = &parentID
	f.DeletedAt = nil
	r.folders[id] = f
	return nil
}
