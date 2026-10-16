package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

func (s *Service) CDWScheduleRead(ctx context.Context, actor domain.User, releaseID string) (ports.CDWActivationSchedule, error) {
	var out ports.CDWActivationSchedule
	if releaseID == "" {
		return out, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	ctrl, ok := tx.(ports.CDWControlStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	fileID, err := ctrl.CDWControlFile(ctx, releaseID)
	if err != nil {
		return out, err
	}
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return out, err
	}
	if _, err = ctrl.CDWControlRole(ctx, actor.ID, "document_control", fileID); err != nil {
		return out, err
	}
	store, ok := tx.(ports.CDWActivationScheduleStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	return store.CDWScheduleGet(ctx, releaseID)
}

func (s *Service) CDWScheduleSet(ctx context.Context, actor domain.User, releaseID string,
	expected int64, enabled bool, key string) (ports.CDWActivationSchedule, error) {
	var out ports.CDWActivationSchedule
	if releaseID == "" || expected < 1 {
		return out, domain.ErrInvalidInput
	}
	raw, err := s.cdwControlMutate(ctx, actor, "control.schedule", key,
		cdwCommandHash("control.schedule", releaseID, struct {
			Expected int64
			Enabled  bool
		}{expected, enabled}),
		releaseID, 200, func(tx ports.Tx, ctrl ports.CDWControlStore) (any, error) {
			fileID, e := ctrl.CDWControlFile(ctx, releaseID)
			if e != nil {
				return nil, e
			}
			if _, e = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			if _, e = ctrl.CDWControlRole(ctx, actor.ID, "document_control", fileID); e != nil {
				return nil, e
			}
			store, ok := tx.(ports.CDWActivationScheduleStore)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			return store.CDWScheduleConfigure(ctx, releaseID, actor.ID, expected, enabled)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}

// The sponsor's live identity and document-control authority are checked
// again at execution time. This is not a privileged service impersonation.
// Scheduler and manual approval use the same atomically audited G8 engine.
func (s *Service) CDWRunScheduledActivation(ctx context.Context, claim ports.CDWDueActivation) (ports.CDWActivationDecision, error) {
	var out ports.CDWActivationDecision
	if claim.ReleaseID == "" || claim.SponsorID == "" || claim.LeaseToken == "" || claim.ReleaseRevision < 1 {
		return out, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return out, err
	}
	actor, err := tx.UserByID(ctx, claim.SponsorID)
	_ = tx.Rollback(ctx)
	if err != nil {
		return out, err
	}
	if actor.DisabledAt != nil {
		return out, domain.ErrForbidden
	}
	raw, err := s.cdwControlMutate(ctx, actor, "control.activate.scheduler", claim.LeaseToken,
		cdwCommandHash("control.activate.scheduler", claim.ReleaseID, claim.ReleaseRevision),
		claim.ReleaseID, 200, func(tx ports.Tx, ctrl ports.CDWControlStore) (any, error) {
			schedule, ok := tx.(ports.CDWActivationScheduleStore)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			leased, e := schedule.CDWScheduleVerifyLease(ctx, claim.ReleaseID, actor.ID, claim.LeaseToken)
			if e != nil {
				return nil, e
			}
			if !leased {
				return nil, domain.ErrVersionConflict
			}
			fileID, e := ctrl.CDWControlFile(ctx, claim.ReleaseID)
			if e != nil {
				return nil, e
			}
			if _, e = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			if _, e = ctrl.CDWControlRole(ctx, actor.ID, "document_control", fileID); e != nil {
				return nil, e
			}
			store, ok := tx.(ports.CDWActivationStore)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			decision, e := store.CDWActivateReleaseWithTrigger(ctx, NewID("cdwactivate"), claim.ReleaseID,
				actor.ID, claim.ReleaseRevision, claim.LeaseToken, "scheduler")
			if e != nil {
				return nil, e
			}
			status := "retry"
			if decision.Outcome == "activated" {
				status = "completed"
			}
			finalized, e := schedule.CDWScheduleFinish(ctx, claim.ReleaseID, claim.LeaseToken, status, decision.Blockers)
			if e != nil {
				return nil, e
			}
			if !finalized {
				return nil, domain.ErrVersionConflict
			}
			return decision, nil
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}
