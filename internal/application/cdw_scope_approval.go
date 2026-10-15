package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

type CDWDistributionScopeRoleInput struct {
	FileID string `json:"fileId"`
	UserID string `json:"userId"`
}

func (s *Service) CDWGrantDistributionScopeApprover(ctx context.Context, actor domain.User,
	input CDWDistributionScopeRoleInput, key string) (CDWFormalCreated, error) {
	var out CDWFormalCreated
	if !actor.IsAdmin {
		return out, domain.ErrForbidden
	}
	if input.FileID == "" || input.UserID == "" || input.UserID == actor.ID {
		return out, domain.ErrInvalidInput
	}
	id := NewID("cdwscoperole")
	raw, err := s.cdwDistributionMutate(ctx, actor, "distribution.scope.role.grant", key,
		cdwCommandHash("distribution.scope.role.grant", "", input), input.FileID, 201,
		func(tx ports.Tx, store ports.CDWDistributionStore) (any, error) {
			if _, e := s.visibleFile(ctx, tx, actor, input.FileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			person, e := tx.UserByID(ctx, input.UserID)
			if e != nil || person.DisabledAt != nil {
				return nil, domain.ErrForbidden
			}
			if _, e = s.visibleFile(ctx, tx, person, input.FileID, domain.ActionPreview); e != nil {
				return nil, domain.ErrForbidden
			}
			actual, e := store.CDWDistributionGrantScopeRole(ctx, id, input.UserID, input.FileID, actor.ID)
			return CDWFormalCreated{ID: actual}, e
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}
func (s *Service) CDWApproveDistributionScope(ctx context.Context, actor domain.User, id string,
	expected int64, key string) (ports.CDWDistributionPlan, error) {
	var out ports.CDWDistributionPlan
	if id == "" || expected < 1 {
		return out, domain.ErrInvalidInput
	}
	raw, err := s.cdwDistributionMutate(ctx, actor, "distribution.scope.approve", key,
		cdwCommandHash("distribution.scope.approve", id, expected), id, 200,
		func(tx ports.Tx, store ports.CDWDistributionStore) (any, error) {
			snapshot, e := store.CDWDistributionSnapshot(ctx, id)
			if e != nil {
				return nil, e
			}
			if snapshot.State != "frozen" || snapshot.Revision != expected {
				return nil, domain.ErrVersionConflict
			}
			if _, e = s.visibleFile(ctx, tx, actor, snapshot.FileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			roles, ok := tx.(ports.CDWControlStore)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			if _, e = roles.CDWControlRole(ctx, actor.ID, "scope_approver", snapshot.FileID); e != nil {
				return nil, e
			}
			digest, e := s.cdwVerifiedDistributionDigest(ctx, tx, snapshot)
			if e != nil {
				return nil, e
			}
			return store.CDWDistributionScopeApprove(ctx, NewID("cdwscopeapproval"), id, actor.ID, expected, digest)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}
func (s *Service) CDWDistributionScopeInbox(ctx context.Context, actor domain.User, limit int) ([]ports.CDWDistributionPlan, error) {
	if limit < 1 || limit > 100 {
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
	items, err := store.CDWDistributionScopeInbox(ctx, actor.ID, limit*3)
	if err != nil {
		return nil, err
	}
	result := []ports.CDWDistributionPlan{}
	for _, item := range items {
		if _, e := s.visibleFile(ctx, tx, actor, item.FileID, domain.ActionPreview); e == nil {
			result = append(result, item)
			if len(result) >= limit {
				break
			}
		}
	}
	return result, nil
}
