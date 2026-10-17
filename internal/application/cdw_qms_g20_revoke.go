package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
)

func (s *Service) CDWQMSEscalationRevoke(ctx context.Context, actor domain.User, id string,
	input CDWQMSEscalationReasonInput, key string) (ports.CDWQMSEscalationPolicy, error) {
	var empty ports.CDWQMSEscalationPolicy
	input.Reason = strings.TrimSpace(input.Reason)
	if id == "" || !cdwG20ReasonValid(input.Reason) {
		return empty, domain.ErrInvalidInput
	}
	raw, err := s.cdwFormalMutate(ctx, actor, "qms.escalation.revoke", key,
		cdwCommandHash("qms.escalation.revoke", id, input), id, 200,
		func(tx ports.Tx, _ ports.CDWFormalStore) (any, error) {
			repo, ok := tx.(ports.CDWQMSG16Store)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			fileID, e := repo.CDWQMSEscalationContextFile(ctx, id, "policy")
			if e != nil {
				return nil, e
			}
			if _, e = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			return repo.CDWQMSEscalationRevoke(ctx, id, actor.ID, input.Reason)
		})
	if err != nil {
		return empty, err
	}
	err = json.Unmarshal(raw, &empty)
	return empty, err
}
