package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

func (s *Service) CDWIssueControlledRelease(ctx context.Context, actor domain.User,
	releaseID string, expected int64, key string) (ports.CDWControlledRelease, error) {
	var out ports.CDWControlledRelease
	if releaseID == "" || expected < 1 {
		return out, domain.ErrInvalidInput
	}
	raw, err := s.cdwControlMutate(ctx, actor, "control.issue", key,
		cdwCommandHash("control.issue", releaseID, expected), releaseID, 200,
		func(tx ports.Tx, store ports.CDWControlStore) (any, error) {
			fileID, e := store.CDWControlFile(ctx, releaseID)
			if e != nil {
				return nil, e
			}
			if _, e = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			if _, e = store.CDWControlRole(ctx, actor.ID, "document_control", fileID); e != nil {
				return nil, e
			}
			distributions, ok := tx.(ports.CDWDistributionStore)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			plan, e := distributions.CDWDistributionForRelease(ctx, releaseID)
			if e != nil {
				return nil, e
			}
			snapshot, e := distributions.CDWDistributionSnapshot(ctx, plan.ID)
			if e != nil {
				return nil, e
			}
			if snapshot.State != "approved" || snapshot.Revision != plan.Revision {
				return nil, domain.ErrConflict
			}
			if len(snapshot.Items) != 1 || snapshot.Items[0].ReleaseID != releaseID {
				return nil, domain.ErrConflict
			}
			digest, e := s.cdwVerifiedDistributionDigest(ctx, tx, snapshot)
			if e != nil {
				return nil, e
			}
			if digest != plan.DigestSHA256 {
				return nil, domain.ErrConflict
			}
			return store.CDWControlIssue(ctx, releaseID, actor.ID, expected, plan.ID, digest)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}
