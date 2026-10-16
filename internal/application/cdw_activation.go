package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

func (s *Service) CDWActivateRelease(ctx context.Context, actor domain.User,
	releaseID string, expected int64, key string) (ports.CDWActivationDecision, error) {
	out := ports.CDWActivationDecision{Blockers: []string{}}
	if releaseID == "" || expected < 1 {
		return out, domain.ErrInvalidInput
	}
	raw, err := s.cdwControlMutate(ctx, actor, "control.activate", key,
		cdwCommandHash("control.activate", releaseID, expected), releaseID, 200,
		func(tx ports.Tx, control ports.CDWControlStore) (any, error) {
			fileID, e := control.CDWControlFile(ctx, releaseID)
			if e != nil {
				return nil, e
			}
			if _, e = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			if _, e = control.CDWControlRole(ctx, actor.ID, "document_control", fileID); e != nil {
				return nil, e
			}
			store, ok := tx.(ports.CDWActivationStore)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			return store.CDWActivateRelease(ctx, NewID("cdwactivate"), releaseID, actor.ID, expected, key)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}
