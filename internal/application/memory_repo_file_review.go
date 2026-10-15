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
func (r *memoryRepo) ReviewCommentsFiltered(ctx context.Context, fileID string, version int, before int64, limit int, actor, filter string) ([]domain.FileReviewComment, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.FileReviewComment, 0)
	for _, c := range r.reviewComments {
		if c.FileID != fileID || c.VersionSeq != version || before != 0 && c.ID >= before {
			continue
		}
		if filter == "mine" && (c.AssigneeID != actor || c.Status != domain.ReviewAssigned && c.Status != domain.ReviewRejected) {
			continue
		}
		if filter == "approval" && (c.AuthorID != actor || c.Status != domain.ReviewPendingApproval) {
			continue
		}
		if filter == "done" && c.Status != domain.ReviewApproved && c.Status != domain.ReviewCompletedSelf {
			continue
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}
func (r *memoryRepo) ReviewCommentCounts(_ context.Context, fileID string, version int, actor string) (domain.ReviewCommentCounts, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var n domain.ReviewCommentCounts
	for _, c := range r.reviewComments {
		if c.FileID != fileID || c.VersionSeq != version {
			continue
		}
		n.All++
		if c.AssigneeID == actor && (c.Status == domain.ReviewAssigned || c.Status == domain.ReviewRejected) {
			n.Mine++
		}
		if c.AuthorID == actor && c.Status == domain.ReviewPendingApproval {
			n.Approval++
		}
		if c.Status == domain.ReviewApproved || c.Status == domain.ReviewCompletedSelf {
			n.Done++
		}
	}
	return n, nil
}
func (r *memoryRepo) ReviewCommentEvents(_ context.Context, id int64) ([]domain.ReviewEvent, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]domain.ReviewEvent{}, r.reviewEvents[id]...), nil
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
	c.CreatorID, c.CreatorName = c.AuthorID, c.AuthorName
	if c.Status == "" {
		c.Status = domain.ReviewOpen
	}
	r.reviewComments = append(r.reviewComments, c)
	return c, nil
}
func (r *memoryRepo) ResolveReviewComment(_ context.Context, id int64, actor string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.reviewComments {
		if r.reviewComments[i].ID == id {
			if r.reviewComments[i].Status != domain.ReviewOpen {
				return false, nil
			}
			now := time.Now().UTC()
			r.reviewComments[i].ResolvedAt = &now
			r.reviewComments[i].ResolvedBy = actor
			r.reviewComments[i].Status = domain.ReviewCompletedSelf
			r.reviewComments[i].Revision++
			return true, nil
		}
	}
	return false, nil
}

func (r *memoryRepo) UpdateReviewComment(_ context.Context, c domain.FileReviewComment, expected int) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.reviewComments {
		if r.reviewComments[i].ID == c.ID {
			if r.reviewComments[i].Revision != expected {
				return false, nil
			}
			c.Revision = expected + 1
			r.reviewComments[i] = c
			return true, nil
		}
	}
	return false, nil
}
func (r *memoryRepo) RecordReviewTransition(_ context.Context, c domain.FileReviewComment, previous domain.ReviewStatus, actor, kind, recipient string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.reviewEvents == nil {
		r.reviewEvents = make(map[int64][]domain.ReviewEvent)
	}
	entries := r.reviewEvents[c.ID]
	r.reviewEvents[c.ID] = append(entries, domain.ReviewEvent{ID: int64(len(entries) + 1), ActorID: actor, Kind: kind,
		StatusBefore: previous, StatusAfter: c.Status, AssigneeID: c.AssigneeID, AssigneeName: c.AssigneeName,
		ResolvedBy: c.ResolvedBy, ResolvedByName: c.ResolvedByName, ResolutionNote: c.ResolutionNote,
		ResolvedVersionSeq: c.ResolvedVersionSeq, ApprovalNote: c.ApprovalNote, CreatedAt: time.Now().UTC()})
	if recipient != "" && recipient != actor {
		for _, entry := range r.reviewComments {
			if entry.ID == c.ID {
				r.reviewNotifications = append(r.reviewNotifications, domain.ReviewNotification{ID: int64(len(r.reviewNotifications) + 1), ReviewID: c.ID, FileID: entry.FileID, Kind: kind, CreatedAt: time.Now().UTC()})
				r.reviewNotificationOwners = append(r.reviewNotificationOwners, recipient)
				break
			}
		}
	}
	return nil
}
func (r *memoryRepo) ReviewNotifications(_ context.Context, user string, limit int) ([]domain.ReviewNotification, int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.ReviewNotification, 0)
	unread := 0
	for i := len(r.reviewNotifications) - 1; i >= 0; i-- {
		if r.reviewNotificationOwners[i] != user {
			continue
		}
		n := r.reviewNotifications[i]
		if !n.Read {
			unread++
		}
		if len(out) < limit {
			out = append(out, n)
		}
	}
	return out, unread, nil
}
func (r *memoryRepo) ReadReviewNotification(_ context.Context, user string, id int64) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.reviewNotifications {
		if r.reviewNotifications[i].ID == id && r.reviewNotificationOwners[i] == user {
			if r.reviewNotifications[i].Read {
				return false, nil
			}
			r.reviewNotifications[i].Read = true
			return true, nil
		}
	}
	return false, nil
}
