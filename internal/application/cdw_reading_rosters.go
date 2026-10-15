package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"sort"
)

type CDWReadingRosterInput struct {
	UserIDs []string `json:"userIds"`
}

func (s *Service) cdwReadingMutate(ctx context.Context, actor domain.User, op, key, hash, objectID string, status int,
	run func(ports.Tx, ports.CDWReadingStore) (any, error)) (json.RawMessage, error) {
	if !validCDWOperationKey(key) {
		return nil, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWReadingStore)
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
	if err = auditRequired(ctx, tx, actor, "cdw."+op, "reading", objectID, "success",
		map[string]any{"result": value}); err != nil {
		return nil, err
	}
	if err = store.CDWReadingEvent(ctx, actor.ID, op, objectID, key, value); err != nil {
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
func (s *Service) CDWCreateReadingRoster(ctx context.Context, actor domain.User, targetID string,
	input CDWReadingRosterInput, key string) (ports.CDWReadingRoster, error) {
	var out ports.CDWReadingRoster
	if targetID == "" || len(input.UserIDs) == 0 || len(input.UserIDs) > 100 {
		return out, domain.ErrInvalidInput
	}
	readers := append([]string(nil), input.UserIDs...)
	sort.Strings(readers)
	for i, userID := range readers {
		if userID == "" || (i > 0 && readers[i-1] == userID) {
			return out, domain.ErrInvalidInput
		}
	}
	requestHash := cdwCommandHash("reading.roster.create", targetID, readers)
	rosterID := NewID("cdwroster")
	raw, err := s.cdwReadingMutate(ctx, actor, "reading.roster.create", key, requestHash, targetID, 201,
		func(tx ports.Tx, store ports.CDWReadingStore) (any, error) {
			target, e := store.CDWReadingTargetInfo(ctx, targetID, actor.ID)
			if e != nil {
				return nil, e
			}
			if target.State != "received" {
				return nil, domain.ErrConflict
			}
			if _, e = s.visibleFile(ctx, tx, actor, target.FileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			for _, id := range readers {
				person, e := tx.UserByID(ctx, id)
				if e != nil || person.DisabledAt != nil || person.DepartmentID != target.DepartmentID {
					return nil, domain.ErrForbidden
				}
				if _, e = s.visibleFile(ctx, tx, person, target.FileID, domain.ActionPreview); e != nil {
					return nil, domain.ErrForbidden
				}
			}
			payload, e := json.Marshal(struct {
				TargetID       string   `json:"targetId"`
				BatchID        string   `json:"batchId"`
				ManifestSHA256 string   `json:"manifestSha256"`
				ArtifactSHA256 string   `json:"artifactSha256"`
				DepartmentID   string   `json:"departmentId"`
				Readers        []string `json:"readers"`
			}{targetID, target.BatchID, target.ManifestSHA256, target.ArtifactSHA256, target.DepartmentID, readers})
			if e != nil {
				return nil, e
			}
			sum := sha256.Sum256(payload)
			digest := hex.EncodeToString(sum[:])
			assignmentIDs := make([]string, len(readers))
			grantIDs := make([]string, len(readers))
			for i := range readers {
				assignmentIDs[i] = NewID("cdwreading")
				grantIDs[i] = NewID("cdwreadaccess")
			}
			return store.CDWReadingCreateRoster(ctx, rosterID, targetID, actor.ID, digest, readers, assignmentIDs, grantIDs)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}
func (s *Service) CDWReadingRoster(ctx context.Context, actor domain.User, targetID string) (ports.CDWReadingRoster, error) {
	var out ports.CDWReadingRoster
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWReadingStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	target, err := store.CDWReadingTargetInfo(ctx, targetID, actor.ID)
	if err != nil {
		return out, err
	}
	if _, err = s.visibleFile(ctx, tx, actor, target.FileID, domain.ActionPreview); err != nil {
		return out, err
	}
	return store.CDWReadingRosterInfo(ctx, targetID)
}
