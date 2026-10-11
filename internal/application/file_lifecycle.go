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

const lifecycleMaxNote = 200

type LifecycleDraft struct {
	Action             string     `json:"action"`
	ExpectedVersionSeq int        `json:"expectedVersionSeq"`
	DueAt              *time.Time `json:"dueAt,omitempty"`
	Note               string     `json:"note"`
	RetentionDays      int        `json:"retentionDays,omitempty"`
}
type LifecycleView struct {
	domain.FileLifecycle
	CanManage bool   `json:"canManage"`
	DueStatus string `json:"dueStatus"`
}

func lifecycleDueStatus(due *time.Time, now time.Time) string {
	if due == nil {
		return "none"
	}
	if !due.After(now) {
		return "overdue"
	}
	if due.Before(now.Add(30 * 24 * time.Hour)) {
		return "soon"
	}
	return "scheduled"
}
func lifecycleView(value domain.FileLifecycle, canManage bool, now time.Time) LifecycleView {
	return LifecycleView{FileLifecycle: value, CanManage: canManage, DueStatus: lifecycleDueStatus(value.DueAt, now)}
}
func (s *Service) FileLifecycle(ctx context.Context, u domain.User, id string) (LifecycleView, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return LifecycleView{}, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, id, domain.ActionList)
	if err != nil {
		return LifecycleView{}, err
	}
	value, err := tx.FileLifecycleByID(ctx, id)
	if errors.Is(err, ports.ErrRowMissing) {
		value = domain.FileLifecycle{FileID: id, State: "draft"}
	}
	if err != nil && !errors.Is(err, ports.ErrRowMissing) {
		return LifecycleView{}, err
	}
	allowed := s.require(ctx, tx, u, file.FolderID, domain.ActionModify) == nil
	return lifecycleView(value, allowed, s.now()), nil
}
func (s *Service) SetFileLifecycle(ctx context.Context, u domain.User, id string, draft LifecycleDraft) (LifecycleView, error) {
	draft.Note = strings.TrimSpace(draft.Note)
	if draft.RetentionDays != 0 && draft.RetentionDays != 30 && draft.RetentionDays != 90 && draft.RetentionDays != 365 && draft.RetentionDays != 730 {
		return LifecycleView{}, domain.ErrInvalidInput
	}
	if draft.Action != "archive" && draft.RetentionDays != 0 {
		return LifecycleView{}, domain.ErrInvalidInput
	}
	if draft.ExpectedVersionSeq < 1 || !utf8.ValidString(draft.Note) || utf8.RuneCountInString(draft.Note) > lifecycleMaxNote {
		return LifecycleView{}, domain.ErrInvalidInput
	}
	if draft.Action != "publish" && draft.Action != "archive" && draft.Action != "unarchive" && draft.Action != "set_due" {
		return LifecycleView{}, domain.ErrInvalidInput
	}
	if draft.DueAt != nil {
		due := draft.DueAt.UTC()
		if due.Before(s.now().Add(-24*time.Hour)) || due.After(s.now().AddDate(20, 0, 0)) {
			return LifecycleView{}, domain.ErrInvalidInput
		}
		draft.DueAt = &due
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return LifecycleView{}, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, id, domain.ActionList)
	if err != nil {
		return LifecycleView{}, err
	}
	if err = s.require(ctx, tx, u, file.FolderID, domain.ActionModify); err != nil {
		return LifecycleView{}, err
	}
	if err = tx.LockFileRow(ctx, id); err != nil {
		return LifecycleView{}, notFoundOr(err)
	}
	file, err = tx.FileByID(ctx, id)
	if err != nil || file.DeletedAt != nil {
		return LifecycleView{}, domain.ErrNotFound
	}
	if currentSeq(file) != draft.ExpectedVersionSeq {
		return LifecycleView{}, domain.ErrVersionConflict
	}
	value, err := tx.FileLifecycleByID(ctx, id)
	if errors.Is(err, ports.ErrRowMissing) {
		value = domain.FileLifecycle{FileID: id, State: "draft"}
	}
	if err != nil && !errors.Is(err, ports.ErrRowMissing) {
		return LifecycleView{}, err
	}
	before := value.State
	if draft.Action == "publish" {
		if value.State == "archived" {
			return LifecycleView{}, domain.ErrConflict
		}
		value.State = "released"
		value.PublishedSeq = draft.ExpectedVersionSeq
		value.PublishedAt = s.now().UTC()
		value.PublishedBy = u.ID
		value.DueAt = draft.DueAt
		value.Note = draft.Note
	} else {
		if value.State == "draft" {
			return LifecycleView{}, domain.ErrConflict
		}
		if draft.Action == "archive" && value.PublishedSeq != draft.ExpectedVersionSeq {
			return LifecycleView{}, domain.ErrVersionConflict
		}
		switch draft.Action {
		case "archive":
			if draft.RetentionDays > 0 {
				until := s.now().UTC().AddDate(0, 0, draft.RetentionDays)
				if value.RetentionUntil == nil || value.RetentionUntil.Before(until) {
					value.RetentionUntil = &until
				}
			}
			if value.State == "archived" {
				return LifecycleView{}, domain.ErrConflict
			}
			value.State = "archived"
		case "unarchive":
			if value.RetentionUntil != nil && value.RetentionUntil.After(s.now()) {
				return LifecycleView{}, domain.ErrConflict
			}
			if value.State != "archived" {
				return LifecycleView{}, domain.ErrConflict
			}
			value.State = "released"
		case "set_due":
			if value.State == "archived" {
				return LifecycleView{}, domain.ErrConflict
			}
			value.DueAt = draft.DueAt
		}
	}
	if draft.Action == "publish" || draft.Action == "archive" {
		if _, pending, e := tx.PendingApprovalForFile(ctx, id); e != nil {
			return LifecycleView{}, e
		} else if pending {
			return LifecycleView{}, domain.ErrApprovalPending
		}
		if lock, e := tx.LockByFileID(ctx, id); e == nil && lock.ExpiresAt.After(s.now()) {
			return LifecycleView{}, domain.ErrLocked
		} else if e != nil && !errors.Is(e, ports.ErrRowMissing) {
			return LifecycleView{}, e
		}
		if _, active, e := tx.ActiveOfficeSessionForFile(ctx, id); e != nil {
			return LifecycleView{}, e
		} else if active {
			return LifecycleView{}, domain.ErrLocked
		}
	}
	if err = tx.UpsertFileLifecycle(ctx, value); err != nil {
		return LifecycleView{}, mapError(err)
	}
	if err = auditRequired(ctx, tx, u, "file.lifecycle."+draft.Action, "file", id, "success", map[string]any{
		"before": before, "after": value.State, "versionSeq": value.PublishedSeq, "dueAt": value.DueAt, "retentionUntil": value.RetentionUntil,
	}); err != nil {
		return LifecycleView{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return LifecycleView{}, err
	}
	value.UpdatedAt = s.now().UTC()
	return lifecycleView(value, true, s.now()), nil
}
