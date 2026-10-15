package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"unicode/utf8"
)

type CDWReceiptAcknowledgeInput struct {
	Statement string `json:"statement"`
}

func (s *Service) CDWReceiptInbox(ctx context.Context, actor domain.User, limit int) ([]ports.CDWReceiptTarget, error) {
	if limit < 1 || limit > 100 {
		return nil, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWReceiptStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	items, err := store.CDWReceiptTargets(ctx, actor.ID, limit*3)
	if err != nil {
		return nil, err
	}
	result := []ports.CDWReceiptTarget{}
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
func (s *Service) CDWAcknowledgeDepartment(ctx context.Context, actor domain.User,
	targetID string, expected int64, input CDWReceiptAcknowledgeInput, key string) (ports.CDWDepartmentReceipt, error) {
	var out ports.CDWDepartmentReceipt
	input.Statement = strings.TrimSpace(input.Statement)
	if targetID == "" || expected < 1 || !validCDWOperationKey(key) ||
		!utf8.ValidString(input.Statement) || utf8.RuneCountInString(input.Statement) < 12 ||
		utf8.RuneCountInString(input.Statement) > 2000 {
		return out, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWReceiptStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	operations, ok := tx.(ports.CDWTaskStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	requestHash := cdwCommandHash("receipt.acknowledge", targetID, struct {
		Expected  int64  `json:"expected"`
		Statement string `json:"statement"`
	}{expected, input.Statement})
	prior, replay, err := operations.CDWClaimOperation(ctx, actor.ID, "receipt.acknowledge", key, requestHash)
	if err != nil {
		return out, err
	}
	if replay {
		err = json.Unmarshal(prior, &out)
		return out, err
	}
	fileID, err := store.CDWReceiptTargetFile(ctx, targetID)
	if err != nil {
		return out, err
	}
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return out, err
	}
	out, err = store.CDWReceiptAcknowledge(ctx, targetID, actor.ID, expected, input.Statement,
		NewID("cdwreceipt"), key)
	if err != nil {
		return out, err
	}
	if err = auditRequired(ctx, tx, actor, "cdw.receipt.acknowledge", "distribution_target", targetID,
		"success", map[string]any{"receiptId": out.ReceiptID, "evidenceSHA256": out.EvidenceSHA256,
			"manifestSHA256": out.ManifestSHA256}); err != nil {
		return out, err
	}
	if err = store.CDWReceiptEvent(ctx, actor.ID, "receipt.acknowledged", key, out); err != nil {
		return out, err
	}
	raw, err := json.Marshal(out)
	if err != nil {
		return out, err
	}
	branch, ok := tx.(ports.CDWBranchStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	if err = branch.CDWCompleteOperationRaw(ctx, actor.ID, "receipt.acknowledge", key, 200, raw); err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	return out, nil
}
