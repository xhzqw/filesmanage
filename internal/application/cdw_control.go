package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"time"
	"unicode/utf8"
)

type CDWControlRoleInput struct {
	UserID string `json:"userId"`
	FileID string `json:"fileId"`
}
type CDWControlPrepareInput struct {
	CandidateID        string  `json:"candidateId"`
	RevisionLabel      string  `json:"revisionLabel"`
	PlannedEffectiveAt *string `json:"plannedEffectiveAt,omitempty"`
}

func (s *Service) cdwControlMutate(ctx context.Context, actor domain.User, op, key, hash, aggregate string,
	status int, run func(ports.Tx, ports.CDWControlStore) (any, error)) (json.RawMessage, error) {
	if !validCDWOperationKey(key) {
		return nil, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWControlStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	ops, ok := tx.(ports.CDWTaskStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	prior, replayed, err := ops.CDWClaimOperation(ctx, actor.ID, op, key, hash)
	if err != nil {
		return nil, err
	}
	if replayed {
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
	if err = auditRequired(ctx, tx, actor, "cdw."+op, "release", aggregate, "success",
		map[string]any{"result": value}); err != nil {
		return nil, err
	}
	if err = store.CDWControlEvent(ctx, actor.ID, op, aggregate, key, map[string]any{"result": value}); err != nil {
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
func (s *Service) CDWControlGrantRole(ctx context.Context, actor domain.User, input CDWControlRoleInput, key string) (CDWFormalCreated, error) {
	var result CDWFormalCreated
	if !actor.IsAdmin {
		return result, domain.ErrForbidden
	}
	if input.FileID == "" || input.UserID == "" {
		return result, domain.ErrInvalidInput
	}
	id := NewID("cdwcontrolrole")
	raw, err := s.cdwControlMutate(ctx, actor, "control.role.grant", key,
		cdwCommandHash("control.role.grant", "", input), input.FileID, 201,
		func(tx ports.Tx, store ports.CDWControlStore) (any, error) {
			if _, e := s.visibleFile(ctx, tx, actor, input.FileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			subject, e := tx.UserByID(ctx, input.UserID)
			if e != nil || subject.DisabledAt != nil {
				return nil, domain.ErrForbidden
			}
			if _, e = s.visibleFile(ctx, tx, subject, input.FileID, domain.ActionPreview); e != nil {
				return nil, domain.ErrForbidden
			}
			actual, e := store.CDWControlGrantRole(ctx, id, input.UserID, input.FileID, actor.ID)
			return CDWFormalCreated{ID: actual}, e
		})
	if err != nil {
		return result, err
	}
	err = json.Unmarshal(raw, &result)
	return result, err
}
func (s *Service) CDWControlCandidates(ctx context.Context, actor domain.User, limit int) ([]ports.CDWApprovedCandidate, error) {
	if limit < 1 || limit > 100 {
		return nil, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWControlStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	rows, err := store.CDWControlCandidates(ctx, limit)
	if err != nil {
		return nil, err
	}
	out := []ports.CDWApprovedCandidate{}
	for _, row := range rows {
		if _, e := s.visibleFile(ctx, tx, actor, row.FileID, domain.ActionPreview); e != nil {
			continue
		}
		if !actor.IsAdmin {
			if _, e := store.CDWControlRole(ctx, actor.ID, "document_control", row.FileID); e != nil {
				continue
			}
		}
		out = append(out, row)
	}
	return out, nil
}
func (s *Service) CDWControlPrepare(ctx context.Context, actor domain.User, input CDWControlPrepareInput, key string) (ports.CDWControlledRelease, error) {
	var result ports.CDWControlledRelease
	label := strings.TrimSpace(input.RevisionLabel)
	if input.CandidateID == "" || label == "" || label != input.RevisionLabel || utf8.RuneCountInString(label) > 60 {
		return result, domain.ErrInvalidInput
	}
	if input.PlannedEffectiveAt != nil {
		at, err := time.Parse(time.RFC3339, *input.PlannedEffectiveAt)
		if err != nil || !at.After(time.Now()) {
			return result, domain.ErrInvalidInput
		}
	}
	id := NewID("cdwrelease")
	artifactID := NewID("cdwartifact")
	raw, err := s.cdwControlMutate(ctx, actor, "control.prepare", key, cdwCommandHash("control.prepare", "", input), id, 201,
		func(tx ports.Tx, store ports.CDWControlStore) (any, error) {
			fileID, e := store.CDWControlCandidateFile(ctx, input.CandidateID)
			if e != nil {
				return nil, e
			}
			if _, e = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			if _, e = store.CDWControlRole(ctx, actor.ID, "document_control", fileID); e != nil {
				return nil, e
			}
			return store.CDWControlPrepare(ctx, id, artifactID, input.CandidateID, label, actor.ID, "", input.PlannedEffectiveAt)
		})
	if err != nil {
		return result, err
	}
	err = json.Unmarshal(raw, &result)
	return result, err
}
func (s *Service) CDWControlList(ctx context.Context, actor domain.User, fileID string) ([]ports.CDWControlledRelease, error) {
	if fileID == "" {
		return nil, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWControlStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return nil, err
	}
	return store.CDWControlList(ctx, fileID, 100)
}
