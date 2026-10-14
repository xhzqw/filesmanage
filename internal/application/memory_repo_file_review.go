package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"sort"
	"time"
)

func (r *memoryRepo) ReviewComments(_ context.Context, fileID string, version int, before int64, limit int) ([]domain.FileReviewComment, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.FileReviewComment, 0)
	for _, v := range r.reviewComments {
		if v.FileID == fileID && v.VersionSeq == version && (before == 0 || v.ID < before) {
			out = append(out, v)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}
func (r *memoryRepo) ReviewCommentByID(_ context.Context, id int64) (domain.FileReviewComment, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, v := range r.reviewComments {
		if v.ID == id {
			return v, nil
		}
	}
	return domain.FileReviewComment{}, ports.ErrRowMissing
}
func (r *memoryRepo) InsertReviewComment(_ context.Context, c domain.FileReviewComment) (domain.FileReviewComment, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c.ID = int64(len(r.reviewComments) + 1)
	c.CreatedAt = time.Now().UTC()
	r.reviewComments = append(r.reviewComments, c)
	return c, nil
}
func (r *memoryRepo) ResolveReviewComment(_ context.Context, id int64, actor string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.reviewComments {
		if r.reviewComments[i].ID == id {
			if r.reviewComments[i].ResolvedAt != nil {
				return false, nil
			}
			now := time.Now().UTC()
			r.reviewComments[i].ResolvedAt = &now
			r.reviewComments[i].ResolvedBy = actor
			return true, nil
		}
	}
	return false, nil
}
