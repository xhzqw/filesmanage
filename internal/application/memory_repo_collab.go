package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"sort"
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

// SearchFiles mirrors the SQL search read for unit tests: the same supported
// sort keys, the same keyset cursor and the same contract that Total counts the
// whole filter while Limit only cuts the page (WF-30).
func (r *memoryRepo) SearchFiles(_ context.Context, q ports.FileSearchQuery) ([]domain.File, int, error) {
	switch q.Sort {
	case "", "updated_desc", "name_asc", "size_desc":
	default:
		return nil, 0, domain.ErrInvalidInput
	}
	// The service sends page size + 1 lookahead, so the ceiling is
	// MaxSearchPage+1; a plain max-size request must not fail here.
	if q.Limit <= 0 || q.Limit > ports.MaxSearchPage+1 {
		return nil, 0, domain.ErrInvalidInput
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	matched := make([]domain.File, 0)
	total := 0
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
		// Total counts the whole filter, so it is tallied before the cursor
		// trims the page — the same contract the SQL count query keeps.
		total++
		if !searchFileAfterCursor(f, q) {
			continue
		}
		matched = append(matched, f)
	}
	sortFiles(matched, q.Sort)
	if len(matched) > q.Limit {
		matched = matched[:q.Limit]
	}
	return matched, total, nil
}

// searchFileAfterCursor mirrors the SQL keyset predicates: each supported sort
// compares the row against the cursor on its own ordering keys.
func searchFileAfterCursor(f domain.File, q ports.FileSearchQuery) bool {
	if q.CursorID == "" {
		return true
	}
	switch q.Sort {
	case "name_asc":
		return f.Name > q.CursorName || (f.Name == q.CursorName && f.ID > q.CursorID)
	case "size_desc":
		return f.SizeBytes < q.CursorSize || (f.SizeBytes == q.CursorSize && f.ID < q.CursorID)
	default:
		return f.UpdatedAt.Before(q.CursorTime) || (f.UpdatedAt.Equal(q.CursorTime) && f.ID < q.CursorID)
	}
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

// ExportFilesStream yields the in-memory equivalents of the export rows; the
// memory repository exists for unit tests, not production scale, so it applies
// the same filters directly instead of reusing the capped search path.
func (r *memoryRepo) ExportFilesStream(_ context.Context, q ports.StatsQuery, yield func(ports.ExportRow) error) error {
	r.mu.Lock()
	visible := make([]domain.File, 0, len(r.files))
	for _, f := range r.files {
		if f.DeletedAt != nil {
			continue
		}
		if q.FolderID != "" && f.FolderID != q.FolderID {
			continue
		}
		if q.Uploader != "" && f.UploadedBy != q.Uploader {
			continue
		}
		if q.MimePrefix != "" && !strings.HasPrefix(strings.ToLower(f.ContentType), strings.ToLower(q.MimePrefix)) {
			continue
		}
		visible = append(visible, f)
	}
	r.mu.Unlock()
	sort.Slice(visible, func(i, j int) bool {
		if visible[i].UpdatedAt.Equal(visible[j].UpdatedAt) {
			return visible[i].ID > visible[j].ID
		}
		return visible[i].UpdatedAt.After(visible[j].UpdatedAt)
	})
	for _, f := range visible {
		seq := 0
		if f.CurrentVersionSeq != nil {
			seq = *f.CurrentVersionSeq
		}
		row := ports.ExportRow{
			FileID: f.ID, Path: f.FolderID, Name: f.Name, UploaderID: f.UploadedBy,
			SizeBytes: f.SizeBytes, VersionSeq: seq, UpdatedAt: f.UpdatedAt,
		}
		if err := yield(row); err != nil {
			return err
		}
	}
	return nil
}

// FolderSharesForSubject mirrors the PostgreSQL ancestor resolution for unit
// tests: the share on the folder itself plus ancestor shares when
// include_descendants is set.
func (r *memoryRepo) FolderSharesForSubject(_ context.Context, userID string, groupIDs []string, folderID string) ([]domain.Share, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	depths := map[string]int{folderID: 0}
	current := folderID
	for depth := 1; depth < 64; depth++ {
		folder, ok := r.folders[current]
		if !ok || folder.ParentID == nil {
			break
		}
		parent := *folder.ParentID
		if _, seen := depths[parent]; seen {
			break
		}
		depths[parent] = depth
		current = parent
	}
	groups := make(map[string]bool, len(groupIDs))
	for _, g := range groupIDs {
		groups[g] = true
	}
	out := make([]domain.Share, 0)
	for _, share := range r.shares {
		if share.FolderID == nil || share.RevokedAt != nil {
			continue
		}
		depth, onChain := depths[*share.FolderID]
		if !onChain || (depth > 0 && !share.IncludeDescendants) {
			continue
		}
		if share.RecipientKind == "user" && share.RecipientID == userID {
			out = append(out, share)
			continue
		}
		if share.RecipientKind == "group" && groups[share.RecipientID] {
			out = append(out, share)
		}
	}
	return out, nil
}

// FileSharesForSubject mirrors the PostgreSQL file-share lookup for unit tests.
func (r *memoryRepo) FileSharesForSubject(_ context.Context, userID string, groupIDs []string, fileID string) ([]domain.Share, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	groups := make(map[string]bool, len(groupIDs))
	for _, g := range groupIDs {
		groups[g] = true
	}
	out := make([]domain.Share, 0)
	for _, share := range r.shares {
		if share.FileID == nil || *share.FileID != fileID || share.RevokedAt != nil {
			continue
		}
		if share.RecipientKind == "user" && share.RecipientID == userID {
			out = append(out, share)
			continue
		}
		if share.RecipientKind == "group" && groups[share.RecipientID] {
			out = append(out, share)
		}
	}
	return out, nil
}

// UpsertFileText keeps the in-memory index row for unit tests.
func (r *memoryRepo) UpsertFileText(_ context.Context, fileID string, seq int, content, spaced string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.fileText == nil {
		r.fileText = map[string]memoryFileText{}
	}
	r.fileText[fileID] = memoryFileText{Seq: seq, Content: content, Spaced: spaced}
	return nil
}

// FileIDsMissingText lists active files without an index row for the backfill.
func (r *memoryRepo) FileIDsMissingText(_ context.Context, limit int) ([]string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, limit)
	for id, file := range r.files {
		if file.DeletedAt != nil {
			continue
		}
		if _, indexed := r.fileText[id]; indexed {
			continue
		}
		out = append(out, id)
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}
