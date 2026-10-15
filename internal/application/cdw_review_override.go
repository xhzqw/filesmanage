package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"unicode/utf8"
)

func (s *Service) CDWReviewCandidates(ctx context.Context, reviewer domain.User, gateID string) ([]ports.CDWReviewCandidate, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWReviewStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	gate, err := store.CDWReviewByID(ctx, gateID)
	if err != nil {
		return nil, err
	}
	if reviewer.ID != gate.ReviewerID || !gate.Substitutable {
		return nil, domain.ErrForbidden
	}
	if _, err = s.visibleFile(ctx, tx, reviewer, gate.FileID, domain.ActionPreview); err != nil {
		return nil, err
	}
	result, err := store.CDWReviewCandidates(ctx, gateID)
	if err != nil {
		return nil, err
	}
	authorized := []ports.CDWReviewCandidate{}
	for _, candidate := range result {
		person, e := tx.UserByID(ctx, candidate.ID)
		if e == nil && person.DisabledAt == nil {
			if _, e = s.visibleFile(ctx, tx, person, gate.FileID, domain.ActionPreview); e == nil {
				authorized = append(authorized, candidate)
			}
		}
	}
	return authorized, nil
}
func (s *Service) CDWGrantReview(ctx context.Context, reviewer domain.User, gateID, target, reason string, expected int64, key string) (ports.CDWOverrideGrant, error) {
	var result ports.CDWOverrideGrant
	reason = strings.TrimSpace(reason)
	if !validCDWOperationKey(key) || expected < 1 || target == "" || reason == "" || !utf8.ValidString(reason) || utf8.RuneCountInString(reason) > 1000 {
		return result, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWReviewStore)
	if !ok {
		return result, domain.ErrInvalidInput
	}
	gate, err := store.CDWReviewByID(ctx, gateID)
	if err != nil {
		return result, err
	}
	if gate.ReviewerID != reviewer.ID {
		return result, domain.ErrForbidden
	}
	if !gate.Substitutable {
		return result, domain.ErrForbidden
	}
	if _, err = s.visibleFile(ctx, tx, reviewer, gate.FileID, domain.ActionPreview); err != nil {
		return result, err
	}
	person, err := tx.UserByID(ctx, target)
	if err != nil || person.DisabledAt != nil {
		return result, domain.ErrForbidden
	}
	if _, err = s.visibleFile(ctx, tx, person, gate.FileID, domain.ActionPreview); err != nil {
		return result, domain.ErrForbidden
	}
	taskStore, ok := tx.(ports.CDWTaskStore)
	if !ok {
		return result, domain.ErrInvalidInput
	}
	const operation = "review.grant"
	hash := cdwCommandHash(operation, gateID, struct {
		Target, Reason string
		Expected       int64
	}{target, reason, expected})
	prior, replay, err := taskStore.CDWClaimOperation(ctx, reviewer.ID, operation, key, hash)
	if err != nil {
		return result, err
	}
	if replay {
		err = json.Unmarshal(prior, &result)
		return result, err
	}
	result, err = store.CDWGrantReview(ctx, gateID, reviewer.ID, target, expected, reason, NewID("cdwgrant"))
	if err != nil {
		return result, err
	}
	meta := map[string]any{"grantId": result.ID, "taskId": result.TaskID, "actorId": target, "scope": "one_gate", "actions": []string{"substitute_review_gate"}, "reason": reason, "expiresAt": result.ExpiresAt}
	if err = auditRequired(ctx, tx, reviewer, "cdw.review.grant", "review_gate", gateID, "success", meta); err != nil {
		return result, err
	}
	if err = store.CDWReviewEvent(ctx, reviewer.ID, "review.grant", gateID, key, meta); err != nil {
		return result, err
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return result, err
	}
	branch, ok := tx.(ports.CDWBranchStore)
	if !ok {
		return result, domain.ErrInvalidInput
	}
	if err = branch.CDWCompleteOperationRaw(ctx, reviewer.ID, operation, key, 201, raw); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
func (s *Service) CDWReviewGrants(ctx context.Context, reviewer domain.User, gateID string) ([]ports.CDWOverrideGrant, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWReviewStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	gate, err := store.CDWReviewByID(ctx, gateID)
	if err != nil {
		return nil, err
	}
	if reviewer.ID != gate.ReviewerID {
		return nil, domain.ErrForbidden
	}
	if _, err = s.visibleFile(ctx, tx, reviewer, gate.FileID, domain.ActionPreview); err != nil {
		return nil, err
	}
	return store.CDWReviewGrants(ctx, gateID)
}
func (s *Service) CDWRevokeReviewGrant(ctx context.Context, reviewer domain.User, gateID, grantID, key string) (ports.CDWOverrideGrant, error) {
	var result ports.CDWOverrideGrant
	if !validCDWOperationKey(key) || grantID == "" {
		return result, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWReviewStore)
	if !ok {
		return result, domain.ErrInvalidInput
	}
	gate, err := store.CDWReviewByID(ctx, gateID)
	if err != nil {
		return result, err
	}
	if gate.ReviewerID != reviewer.ID {
		return result, domain.ErrForbidden
	}
	if _, err = s.visibleFile(ctx, tx, reviewer, gate.FileID, domain.ActionPreview); err != nil {
		return result, err
	}
	taskStore, ok := tx.(ports.CDWTaskStore)
	if !ok {
		return result, domain.ErrInvalidInput
	}
	const operation = "review.revoke"
	hash := cdwCommandHash(operation, gateID, grantID)
	prior, replay, err := taskStore.CDWClaimOperation(ctx, reviewer.ID, operation, key, hash)
	if err != nil {
		return result, err
	}
	if replay {
		err = json.Unmarshal(prior, &result)
		return result, err
	}
	result, err = store.CDWRevokeReviewGrant(ctx, gateID, grantID, reviewer.ID)
	if err != nil {
		return result, err
	}
	meta := map[string]any{"grantId": grantID, "actorId": result.ActorID, "taskId": result.TaskID}
	if err = auditRequired(ctx, tx, reviewer, "cdw.review.revoke", "review_gate", gateID, "success", meta); err != nil {
		return result, err
	}
	if err = store.CDWReviewEvent(ctx, reviewer.ID, "review.revoke", gateID, key, meta); err != nil {
		return result, err
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return result, err
	}
	branch, ok := tx.(ports.CDWBranchStore)
	if !ok {
		return result, domain.ErrInvalidInput
	}
	if err = branch.CDWCompleteOperationRaw(ctx, reviewer.ID, operation, key, 200, raw); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
