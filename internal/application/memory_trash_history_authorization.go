package application

import "context"

func (r *memoryRepo) TrashHistoryAccessible(_ context.Context, fileID, userID string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	file, ok := r.files[fileID]
	if !ok || file.DeletedAt == nil {
		return false, nil
	}
	ancestors := map[string]bool{}
	for id, i := file.FolderID, 0; id != "" && i < 128; i++ {
		if ancestors[id] {
			break
		}
		ancestors[id] = true
		f, ok := r.folders[id]
		if !ok || f.ParentID == nil {
			break
		}
		id = *f.ParentID
	}
	for _, entry := range r.trash {
		if entry.RestoredAt != nil || entry.PurgedAt != nil || entry.DeletedBy != userID {
			continue
		}
		if (entry.FileID != nil && *entry.FileID == fileID) ||
			(entry.FolderID != nil && ancestors[*entry.FolderID]) {
			return true, nil
		}
	}
	return false, nil
}
