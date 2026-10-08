package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"time"
)

// In-memory collaboration stores for unit tests.

func (r *memoryRepo) ListSharesForSubject(_ context.Context, userID string, groupIDs []string) ([]domain.Share, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.Share, 0)
	for _, s := range r.shares {
		if s.RevokedAt != nil {
			continue
		}
		match := (s.RecipientKind == "user" && s.RecipientID == userID) ||
			(s.RecipientKind == "group" && contains(groupIDs, s.RecipientID))
		if match {
			out = append(out, s)
		}
	}
	return out, nil
}

func (r *memoryRepo) ListSharesCreatedBy(_ context.Context, userID string) ([]domain.Share, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.Share, 0)
	for _, s := range r.shares {
		if s.CreatedBy == userID {
			out = append(out, s)
		}
	}
	return out, nil
}

func (r *memoryRepo) ShareByID(_ context.Context, id string) (domain.Share, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.shares {
		if s.ID == id {
			return s, nil
		}
	}
	return domain.Share{}, ports.ErrRowMissing
}

func (r *memoryRepo) CreateShare(_ context.Context, s domain.Share) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, a := range s.Actions {
		if a != domain.ActionList && a != domain.ActionPreview && a != domain.ActionDownload {
			return domain.ErrInvalidInput
		}
	}
	if (s.FileID == nil) == (s.FolderID == nil) {
		return domain.ErrInvalidInput
	}
	r.shares = append(r.shares, s)
	return nil
}

func (r *memoryRepo) RevokeShare(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, s := range r.shares {
		if s.ID == id {
			now := time.Now()
			r.shares[i].RevokedAt = &now
			return nil
		}
	}
	return ports.ErrRowMissing
}

func (r *memoryRepo) ListFavorites(_ context.Context, userID string) ([]domain.Favorite, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.Favorite, 0)
	for _, f := range r.favorites {
		if f.UserID == userID {
			out = append(out, f)
		}
	}
	return out, nil
}

func (r *memoryRepo) FavoriteExists(_ context.Context, userID, fileID, folderID string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, f := range r.favorites {
		if f.UserID != userID {
			continue
		}
		if fileID != "" && f.FileID != nil && *f.FileID == fileID {
			return true, nil
		}
		if folderID != "" && f.FolderID != nil && *f.FolderID == folderID {
			return true, nil
		}
	}
	return false, nil
}

func (r *memoryRepo) AddFavorite(_ context.Context, f domain.Favorite) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.favorites = append(r.favorites, f)
	return nil
}

func (r *memoryRepo) RemoveFavorite(_ context.Context, userID, fileID, folderID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, f := range r.favorites {
		if f.UserID != userID {
			continue
		}
		if (fileID != "" && f.FileID != nil && *f.FileID == fileID) || (folderID != "" && f.FolderID != nil && *f.FolderID == folderID) {
			r.favorites = append(r.favorites[:i], r.favorites[i+1:]...)
			return nil
		}
	}
	return ports.ErrRowMissing
}

func (r *memoryRepo) SearchFiles(_ context.Context, q ports.FileSearchQuery) ([]domain.File, int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.File, 0)
	for _, f := range r.files {
		if f.DeletedAt != nil {
			continue
		}
		if q.FolderID != "" && f.FolderID != q.FolderID {
			continue
		}
		if q.Query != "" && !strings.Contains(lowerASCII(f.Name), lowerASCII(q.Query)) {
			continue
		}
		out = append(out, f)
	}
	if q.Limit > 0 && len(out) > q.Limit {
		out = out[:q.Limit]
	}
	return out, len(out), nil
}

func (r *memoryRepo) Stats(_ context.Context, q ports.StatsQuery) (domain.Stats, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var stats domain.Stats
	for _, f := range r.files {
		if f.DeletedAt != nil {
			continue
		}
		if q.FolderID != "" && f.FolderID != q.FolderID {
			continue
		}
		stats.TotalFiles++
		stats.TotalBytes += f.SizeBytes
	}
	return stats, nil
}

func (r *memoryRepo) ExportFiles(ctx context.Context, q ports.StatsQuery, limit int) ([]domain.File, error) {
	files, _, err := r.SearchFiles(ctx, ports.FileSearchQuery{UserID: q.UserID, FolderID: q.FolderID, Limit: limit})
	return files, err
}
