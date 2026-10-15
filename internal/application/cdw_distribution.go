package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

type CDWDistributionCreateInput struct {
	ReleaseID string                             `json:"releaseId"`
	Targets   []ports.CDWDistributionTargetInput `json:"targets"`
}

func (s *Service) cdwDistributionMutate(ctx context.Context, actor domain.User, op, key, hash, id string,
	status int, run func(ports.Tx, ports.CDWDistributionStore) (any, error)) (json.RawMessage, error) {
	if !validCDWOperationKey(key) {
		return nil, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWDistributionStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	ops, ok := tx.(ports.CDWTaskStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	prior, replay, err := ops.CDWClaimOperation(ctx, actor.ID, op, key, hash)
	if err != nil {
		return nil, err
	}
	if replay {
		return prior, nil
	}
	value, err := run(tx, store)
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if err = auditRequired(ctx, tx, actor, "cdw."+op, "distribution_plan", id, "success",
		map[string]any{"result": value}); err != nil {
		return nil, err
	}
	if err = store.CDWDistributionEvent(ctx, actor.ID, op, id, key, value); err != nil {
		return nil, err
	}
	branch, ok := tx.(ports.CDWBranchStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	if err = branch.CDWCompleteOperationRaw(ctx, actor.ID, op, key, status, raw); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return raw, nil
}
func (s *Service) CDWDistributionCreate(ctx context.Context, actor domain.User,
	input CDWDistributionCreateInput, key string) (ports.CDWDistributionPlan, error) {
	var out ports.CDWDistributionPlan
	if input.ReleaseID == "" || len(input.Targets) < 1 || len(input.Targets) > 30 {
		return out, domain.ErrInvalidInput
	}
	seen := map[string]bool{}
	for _, t := range input.Targets {
		if t.DepartmentID == "" || t.ReceiverID == "" || seen[t.DepartmentID] {
			return out, domain.ErrInvalidInput
		}
		seen[t.DepartmentID] = true
	}
	id := NewID("cdwplan")
	raw, err := s.cdwDistributionMutate(ctx, actor, "distribution.create", key,
		cdwCommandHash("distribution.create", "", input), id, 201,
		func(tx ports.Tx, store ports.CDWDistributionStore) (any, error) {
			fileID, e := store.CDWDistributionReleaseFile(ctx, input.ReleaseID)
			if e != nil {
				return nil, e
			}
			if _, e = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			roles, ok := tx.(ports.CDWControlStore)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			if _, e = roles.CDWControlRole(ctx, actor.ID, "document_control", fileID); e != nil {
				return nil, e
			}
			for _, target := range input.Targets {
				person, e := tx.UserByID(ctx, target.ReceiverID)
				if e != nil || person.DisabledAt != nil || person.DepartmentID != target.DepartmentID {
					return nil, domain.ErrForbidden
				}
				if _, e = s.visibleFile(ctx, tx, person, fileID, domain.ActionPreview); e != nil {
					return nil, domain.ErrForbidden
				}
			}
			return store.CDWDistributionCreate(ctx, id, input.ReleaseID, actor.ID, input.Targets)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}
func (s *Service) CDWDistributionFreeze(ctx context.Context, actor domain.User, id string,
	revision int64, key string) (ports.CDWDistributionPlan, error) {
	var out ports.CDWDistributionPlan
	if id == "" || revision < 1 {
		return out, domain.ErrInvalidInput
	}
	raw, err := s.cdwDistributionMutate(ctx, actor, "distribution.freeze", key,
		cdwCommandHash("distribution.freeze", id, revision), id, 200,
		func(tx ports.Tx, store ports.CDWDistributionStore) (any, error) {
			snapshot, e := store.CDWDistributionSnapshot(ctx, id)
			if e != nil {
				return nil, e
			}
			if snapshot.State != "draft" || snapshot.Revision != revision {
				return nil, domain.ErrVersionConflict
			}
			if len(snapshot.Items) != 1 || len(snapshot.Targets) < 1 {
				return nil, domain.ErrConflict
			}
			if _, e = s.visibleFile(ctx, tx, actor, snapshot.FileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			roles, ok := tx.(ports.CDWControlStore)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			if _, e = roles.CDWControlRole(ctx, actor.ID, "document_control", snapshot.FileID); e != nil {
				return nil, e
			}
			digest, e := s.cdwVerifiedDistributionDigest(ctx, tx, snapshot)
			if e != nil {
				return nil, domain.ErrInvalidInput
			}
			return store.CDWDistributionFreeze(ctx, id, actor.ID, revision, digest)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}
func (s *Service) CDWDistributionForRelease(ctx context.Context, actor domain.User, releaseID string) (ports.CDWDistributionPlan, error) {
	var out ports.CDWDistributionPlan
	if releaseID == "" {
		return out, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWDistributionStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	fileID, err := store.CDWDistributionReleaseFile(ctx, releaseID)
	if err != nil {
		return out, err
	}
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return out, err
	}
	roles, ok := tx.(ports.CDWControlStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	if _, err = roles.CDWControlRole(ctx, actor.ID, "document_control", fileID); err != nil {
		return out, err
	}
	return store.CDWDistributionForRelease(ctx, releaseID)
}
func (s *Service) CDWDistributionRead(ctx context.Context, actor domain.User, id string) (ports.CDWDistributionPlan, error) {
	var out ports.CDWDistributionPlan
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWDistributionStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	fileID, err := store.CDWDistributionPlanFile(ctx, id)
	if err != nil {
		return out, err
	}
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return out, err
	}
	roles, ok := tx.(ports.CDWControlStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	if _, err = roles.CDWControlRole(ctx, actor.ID, "document_control", fileID); err != nil {
		return out, err
	}
	return store.CDWDistributionRead(ctx, id)
}
