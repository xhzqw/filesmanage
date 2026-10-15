package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"io"
	"strings"
	"unicode/utf8"
)

func (s *Service) CDWReviewInbox(ctx context.Context, actor domain.User, limit int) ([]ports.CDWReviewGate, error) {
	if limit < 1 || limit > 100 {
		return nil, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWReviewStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	gates, err := store.CDWReviewInbox(ctx, actor.ID, limit)
	if err != nil {
		return nil, err
	}
	out := make([]ports.CDWReviewGate, 0, len(gates))
	for _, gate := range gates {
		if _, err = s.visibleFile(ctx, tx, actor, gate.FileID, domain.ActionPreview); err == nil {
			out = append(out, gate)
		}
	}
	return out, nil
}
func (s *Service) CDWReviewContent(ctx context.Context, actor domain.User, id string) (io.ReadSeekCloser, string, int64, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, "", 0, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWReviewStore)
	if !ok {
		return nil, "", 0, domain.ErrInvalidInput
	}
	gate, err := store.CDWReviewByID(ctx, id)
	if err != nil {
		return nil, "", 0, err
	}
	if gate.ReviewerID != actor.ID {
		return nil, "", 0, domain.ErrForbidden
	}
	if _, err = s.visibleFile(ctx, tx, actor, gate.FileID, domain.ActionPreview); err != nil {
		return nil, "", 0, err
	}
	src, err := store.CDWReviewBlobSource(ctx, id)
	if err != nil {
		return nil, "", 0, err
	}
	reader, err := s.blobs.Open(src.StorageKey)
	return reader, src.Name, src.SizeBytes, err
}
func (s *Service) CDWReviewGate(ctx context.Context, actor domain.User, id string) (ports.CDWReviewGate, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return ports.CDWReviewGate{}, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWReviewStore)
	if !ok {
		return ports.CDWReviewGate{}, domain.ErrInvalidInput
	}
	gate, err := store.CDWReviewByID(ctx, id)
	if err != nil {
		return gate, err
	}
	if gate.ReviewerID != actor.ID {
		return ports.CDWReviewGate{}, domain.ErrForbidden
	}
	if _, err = s.visibleFile(ctx, tx, actor, gate.FileID, domain.ActionPreview); err != nil {
		return ports.CDWReviewGate{}, err
	}
	return gate, nil
}
func (s *Service) CDWDecideReview(ctx context.Context, actor domain.User, gateID, decision, reason string, expected int64, key string) (ports.CDWReviewDecisionResult, error) {
	var result ports.CDWReviewDecisionResult
	reason = strings.TrimSpace(reason)
	if !validCDWOperationKey(key) || expected < 1 || (decision != "accept" && decision != "return") ||
		(decision == "return" && reason == "") || !utf8.ValidString(reason) || utf8.RuneCountInString(reason) > 3000 {
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
	if gate.ReviewerID != actor.ID {
		return result, domain.ErrForbidden
	}
	if _, err = s.visibleFile(ctx, tx, actor, gate.FileID, domain.ActionPreview); err != nil {
		return result, err
	}
	taskStore, ok := tx.(ports.CDWTaskStore)
	if !ok {
		return result, domain.ErrInvalidInput
	}
	const operation = "review.decide"
	hash := cdwCommandHash(operation, gateID, struct {
		Decision string `json:"decision"`
		Reason   string `json:"reason"`
		Expected int64  `json:"expected"`
	}{decision, reason, expected})
	prior, replay, err := taskStore.CDWClaimOperation(ctx, actor.ID, operation, key, hash)
	if err != nil {
		return result, err
	}
	if replay {
		if err = json.Unmarshal(prior, &result); err != nil {
			return result, err
		}
		return result, nil
	}
	result, err = store.CDWDecideReview(ctx, gateID, actor.ID, expected, decision, reason, NewID("cdwdecision"), NewID("cdwreturn"))
	if err != nil {
		return result, err
	}
	if err = auditRequired(ctx, tx, actor, "cdw.review."+decision, "review_gate", gateID, "success",
		map[string]any{"taskId": result.TaskID, "deliveryId": result.DeliveryID, "reviewer": actor.ID, "reason": reason, "round": result.Round}); err != nil {
		return result, err
	}
	if err = store.CDWReviewEvent(ctx, actor.ID, "review."+decision, gateID, key, map[string]any{
		"taskId": result.TaskID, "deliveryId": result.DeliveryID, "state": result.State, "round": result.Round,
	}); err != nil {
		return result, err
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return result, err
	}
	branchStore, ok := tx.(ports.CDWBranchStore)
	if !ok {
		return result, domain.ErrInvalidInput
	}
	if err = branchStore.CDWCompleteOperationRaw(ctx, actor.ID, operation, key, 200, raw); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
func (s *Service) CDWResumeReturned(ctx context.Context, actor domain.User, taskID string, expected int64, key string) (ports.CDWResumeResult, error) {
	var result ports.CDWResumeResult
	if !validCDWOperationKey(key) || taskID == "" || expected < 1 {
		return result, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	taskStore, ok := tx.(ports.CDWTaskStore)
	if !ok {
		return result, domain.ErrInvalidInput
	}
	fileID, _, _, err := taskStore.CDWTaskScope(ctx, taskID)
	if err != nil {
		return result, err
	}
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return result, err
	}
	const operation = "review.resume"
	hash := cdwCommandHash(operation, taskID, struct {
		Expected int64 `json:"expected"`
	}{expected})
	prior, replay, err := taskStore.CDWClaimOperation(ctx, actor.ID, operation, key, hash)
	if err != nil {
		return result, err
	}
	if replay {
		if err = json.Unmarshal(prior, &result); err != nil {
			return result, err
		}
		return result, nil
	}
	store, ok := tx.(ports.CDWReviewStore)
	if !ok {
		return result, domain.ErrInvalidInput
	}
	result, err = store.CDWResumeReturned(ctx, taskID, actor.ID, expected, NewID("cdwbranch"), NewID("cdwrev"))
	if err != nil {
		return result, err
	}
	if err = auditRequired(ctx, tx, actor, "cdw.review.resume", "task", taskID, "success",
		map[string]any{"branchId": result.BranchID, "round": result.Round}); err != nil {
		return result, err
	}
	if err = store.CDWReviewEvent(ctx, actor.ID, "review.resume", taskID, key, map[string]any{
		"taskId": taskID, "branchId": result.BranchID, "round": result.Round,
	}); err != nil {
		return result, err
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return result, err
	}
	branchStore, ok := tx.(ports.CDWBranchStore)
	if !ok {
		return result, domain.ErrInvalidInput
	}
	if err = branchStore.CDWCompleteOperationRaw(ctx, actor.ID, operation, key, 201, raw); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
