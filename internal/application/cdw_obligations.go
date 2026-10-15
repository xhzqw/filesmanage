package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"unicode/utf8"
)

type CDWObligationCompleteInput struct {
	Statement string `json:"statement"`
}

func (s *Service) CDWCompleteObligation(ctx context.Context, actor domain.User, id string,
	input CDWObligationCompleteInput, expected int64, key string) (ports.CDWObligationFulfillment, error) {
	var out ports.CDWObligationFulfillment
	input.Statement = strings.TrimSpace(input.Statement)
	if id == "" || expected < 1 || !validCDWOperationKey(key) || !utf8.ValidString(input.Statement) ||
		utf8.RuneCountInString(input.Statement) < 12 || utf8.RuneCountInString(input.Statement) > 3000 {
		return out, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWObligationStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	operations, ok := tx.(ports.CDWTaskStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	hash := cdwCommandHash("obligation.fulfill", id, struct {
		Input    CDWObligationCompleteInput `json:"input"`
		Expected int64                      `json:"expected"`
	}{input, expected})
	prior, replay, err := operations.CDWClaimOperation(ctx, actor.ID, "obligation.fulfill", key, hash)
	if err != nil {
		return out, err
	}
	if replay {
		err = json.Unmarshal(prior, &out)
		return out, err
	}
	fileID, err := store.CDWObligationFile(ctx, id)
	if err != nil {
		return out, err
	}
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return out, err
	}
	out, err = store.CDWFulfillObligation(ctx, id, actor.ID, expected, input.Statement, NewID("cdwoblev"))
	if err != nil {
		return out, err
	}
	if err = auditRequired(ctx, tx, actor, "cdw.obligation.fulfill", "obligation", id, "success",
		map[string]any{"taskId": out.TaskID, "kind": out.Kind, "evidenceSha256": out.EvidenceSHA256}); err != nil {
		return out, err
	}
	if err = store.CDWObligationEvent(ctx, actor.ID, "fulfilled", key, out); err != nil {
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
	if err = branch.CDWCompleteOperationRaw(ctx, actor.ID, "obligation.fulfill", key, 200, raw); err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	return out, nil
}
