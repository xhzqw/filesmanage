package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"unicode/utf8"
)

type CDWDistributionWithdrawalInput struct {
	Reason string `json:"reason"`
}

func (s *Service) CDWWithdrawDistribution(ctx context.Context, actor domain.User, planID string,
	expected int64, input CDWDistributionWithdrawalInput, key string) (ports.CDWDistributionWithdrawal, error) {
	var out ports.CDWDistributionWithdrawal
	input.Reason = strings.TrimSpace(input.Reason)
	if planID == "" || expected < 1 || !utf8.ValidString(input.Reason) ||
		utf8.RuneCountInString(input.Reason) < 12 || utf8.RuneCountInString(input.Reason) > 3000 {
		return out, domain.ErrInvalidInput
	}
	raw, err := s.cdwDistributionMutate(ctx, actor, "distribution.withdraw", key,
		cdwCommandHash("distribution.withdraw", planID, struct {
			Expected int64  `json:"expected"`
			Reason   string `json:"reason"`
		}{expected, input.Reason}), planID, 200,
		func(tx ports.Tx, store ports.CDWDistributionStore) (any, error) {
			fileID, e := store.CDWDistributionPlanFile(ctx, planID)
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
			return store.CDWDistributionWithdraw(ctx, NewID("cdwbatchexit"),
				planID, actor.ID, expected, input.Reason)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}
