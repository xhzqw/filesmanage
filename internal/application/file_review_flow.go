package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"time"
	"unicode/utf8"
)

// Assignees must be active, distinct from the creator, and able to preview the
// file. A list endpoint is provided because /users is administrator-only.
func (s *Service) requireReviewAssignee(ctx context.Context, tx ports.Repository, fileID, userID string) error {
	target, err := tx.UserByID(ctx, userID)
	if errors.Is(err, ports.ErrRowMissing) {
		return domain.ErrInvalidInput
	}
	if err != nil {
		return err
	}
	if target.DisabledAt != nil {
		return domain.ErrInvalidInput
	}
	_, err = s.visibleFile(ctx, tx, target, fileID, domain.ActionPreview)
	if err != nil {
		return domain.ErrForbidden
	}
	return nil
}

// ReviewAssignable exposes display-safe labels without leaking credentials or
// the organization-wide directory to ordinary reviewers.
type ReviewAssignable struct {
	ID             string `json:"id"`
	DisplayName    string `json:"displayName"`
	DepartmentName string `json:"departmentName,omitempty"`
	Role           string `json:"role"`
}

func (s *Service) ReviewAssignees(ctx context.Context, u domain.User, fileID string) ([]ReviewAssignable, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = s.visibleFile(ctx, tx, u, fileID, domain.ActionPreview); err != nil {
		return nil, err
	}
	users, err := tx.ListUsers(ctx)
	if err != nil {
		return nil, err
	}
	departments, err := tx.ListDepartments(ctx)
	if err != nil {
		return nil, err
	}
	names := make(map[string]string, len(departments))
	for _, department := range departments {
		names[department.ID] = department.Name
	}
	out := make([]ReviewAssignable, 0)
	for _, candidate := range users {
		if candidate.ID == u.ID || candidate.DisabledAt != nil {
			continue
		}
		if _, err = s.visibleFile(ctx, tx, candidate, fileID, domain.ActionPreview); err == nil {
			role := "成员"
			if candidate.IsAdmin {
				role = "管理员"
			}
			out = append(out, ReviewAssignable{ID: candidate.ID, DisplayName: candidate.DisplayName,
				DepartmentName: names[candidate.DepartmentID], Role: role})
		}
	}
	return out, nil
}

// TransitionReviewComment enforces actor roles, legal edges, and an optimistic
// revision guard. It records the event and recipient-scoped notification in the
// same transaction as the state update; notification events publish after commit.
func (s *Service) TransitionReviewComment(ctx context.Context, u domain.User, fileID string, id int64, action, note string, newVersion *int, assignee string) error {
	note = strings.TrimSpace(note)
	if id < 1 || !utf8.ValidString(note) || utf8.RuneCountInString(note) > 3000 || (newVersion != nil && *newVersion < 1) {
		return domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = s.visibleFile(ctx, tx, u, fileID, domain.ActionPreview); err != nil {
		return err
	}
	c, err := tx.ReviewCommentByID(ctx, id)
	if errors.Is(err, ports.ErrRowMissing) || err == nil && c.FileID != fileID {
		return domain.ErrNotFound
	}
	if err != nil {
		return err
	}
	creator := u.ID == c.AuthorID || u.IsAdmin
	handler := u.ID == c.AssigneeID && c.AssigneeID != "" || u.IsAdmin
	expected := c.Revision
	recipient := ""
	now := time.Now().UTC()
	switch action {
	case "assign":
		if !creator {
			return domain.ErrForbidden
		}
		if c.Status != domain.ReviewOpen && c.Status != domain.ReviewRejected && c.Status != domain.ReviewAssigned {
			return domain.ErrVersionConflict
		}
		if assignee == "" || assignee == c.AuthorID {
			return domain.ErrInvalidInput
		}
		if err = s.requireReviewAssignee(ctx, tx, fileID, assignee); err != nil {
			return err
		}
		c.AssigneeID = assignee
		c.Status = domain.ReviewAssigned
		recipient = assignee
		c.ApprovalNote = ""
		c.ApprovedAt = nil
	case "resolve-self":
		if !creator {
			return domain.ErrForbidden
		}
		if c.Status != domain.ReviewOpen && c.Status != domain.ReviewAssigned && c.Status != domain.ReviewRejected {
			return domain.ErrVersionConflict
		}
		c.Status = domain.ReviewCompletedSelf
		c.ResolutionNote = note
		c.ResolvedAt = &now
		c.ResolvedBy = u.ID
		c.ResolvedVersionSeq = newVersion
		c.ApprovalNote = ""
		c.ApprovedAt = nil
		if c.AssigneeID != "" {
			recipient = c.AssigneeID
		}
	case "submit-resolution", "update-resolution":
		if !handler {
			return domain.ErrForbidden
		}
		if action == "submit-resolution" && (c.Status != domain.ReviewAssigned && c.Status != domain.ReviewRejected) ||
			action == "update-resolution" && c.Status != domain.ReviewPendingApproval {
			return domain.ErrVersionConflict
		}
		if note == "" {
			return domain.ErrInvalidInput
		}
		if newVersion != nil {
			if _, err = tx.VersionBySeq(ctx, fileID, *newVersion); err != nil {
				return domain.ErrInvalidInput
			}
		}
		c.Status = domain.ReviewPendingApproval
		c.ResolutionNote = note
		c.ResolvedVersionSeq = newVersion
		c.ResolvedAt = &now
		c.ResolvedBy = u.ID
		c.ApprovalNote = ""
		c.ApprovedAt = nil
		recipient = c.AuthorID
	case "approve", "reject":
		if !creator {
			return domain.ErrForbidden
		}
		if c.Status != domain.ReviewPendingApproval {
			return domain.ErrVersionConflict
		}
		c.ApprovalNote = note
		recipient = c.AssigneeID
		if action == "approve" {
			c.Status = domain.ReviewApproved
			c.ApprovedAt = &now
		} else {
			c.Status = domain.ReviewRejected
			c.ApprovedAt = nil
		}
	case "reopen":
		if !creator {
			return domain.ErrForbidden
		}
		if c.Status != domain.ReviewApproved && c.Status != domain.ReviewCompletedSelf {
			return domain.ErrVersionConflict
		}
		c.Status = domain.ReviewOpen
		c.AssigneeID = ""
		c.ResolutionNote = ""
		c.ResolvedVersionSeq = nil
		c.ResolvedAt = nil
		c.ResolvedBy = ""
		c.ApprovalNote = ""
		c.ApprovedAt = nil
	default:
		return domain.ErrInvalidInput
	}
	won, err := tx.UpdateReviewComment(ctx, c, expected)
	if err != nil {
		return err
	}
	if !won {
		return domain.ErrVersionConflict
	}
	if err = tx.RecordReviewTransition(ctx, id, u.ID, action, note, recipient); err != nil {
		return err
	}
	if err = auditRequired(ctx, tx, u, "file.review_"+action, "file", fileID, "success", map[string]any{"commentId": id, "fromRevision": expected, "status": c.Status}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notifyWorkspaceChange("review")
	if recipient != "" && recipient != u.ID {
		s.publishUserEvent(recipient, UserEvent{Type: "review.changed"})
	}
	return nil
}

type ReviewNoticePage struct {
	Items       []domain.ReviewNotification `json:"items"`
	UnreadCount int                         `json:"unreadCount"`
}

func (s *Service) ReviewNotices(ctx context.Context, u domain.User) (ReviewNoticePage, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return ReviewNoticePage{}, err
	}
	defer tx.Rollback(ctx)
	rows, count, err := tx.ReviewNotifications(ctx, u.ID, 50)
	if err != nil {
		return ReviewNoticePage{}, err
	}
	return ReviewNoticePage{Items: rows, UnreadCount: count}, nil
}
func (s *Service) ReadReviewNotice(ctx context.Context, u domain.User, id int64) error {
	if id < 1 {
		return domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	_, err = tx.ReadReviewNotification(ctx, u.ID, id)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.publishUserEvent(u.ID, UserEvent{Type: "review.changed"})
	return nil
}
