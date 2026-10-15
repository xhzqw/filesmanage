package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

func (s *Service) CDWDispatchDistribution(ctx context.Context, actor domain.User,
	planID string, expected int64, key string) (ports.CDWDistributionBatch, error) {
	var out ports.CDWDistributionBatch
	if planID == "" || expected < 1 {
		return out, domain.ErrInvalidInput
	}
	batchID := NewID("cdwbatch")
	raw, err := s.cdwDistributionMutate(ctx, actor, "distribution.dispatch", key,
		cdwCommandHash("distribution.dispatch", planID, expected), planID, 201,
		func(tx ports.Tx, store ports.CDWDistributionStore) (any, error) {
			snapshot, e := store.CDWDistributionSnapshot(ctx, planID)
			if e != nil {
				return nil, e
			}
			if snapshot.State != "approved" || snapshot.Revision != expected {
				return nil, domain.ErrVersionConflict
			}
			if len(snapshot.Items) != 1 || len(snapshot.Targets) == 0 {
				return nil, domain.ErrConflict
			}
			if _, e = s.visibleFile(ctx, tx, actor, snapshot.FileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			roles, ok := tx.(ports.CDWControlStore)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			if _, e = roles.CDWControlRole(ctx, actor.ID, "document_control", snapshot.FileID); e != nil {
				return nil, e
			}
			digest, e := s.cdwVerifiedDistributionDigest(ctx, tx, snapshot)
			if e != nil {
				return nil, e
			}
			plan, e := store.CDWDistributionRead(ctx, planID)
			if e != nil {
				return nil, e
			}
			if plan.State != "approved" || plan.DigestSHA256 != digest {
				return nil, domain.ErrConflict
			}
			itemIDs := make([]string, len(snapshot.Items))
			targetIDs := make([]string, len(snapshot.Targets))
			grantIDs := make([]string, len(snapshot.Items)*len(snapshot.Targets))
			for i := range itemIDs {
				itemIDs[i] = NewID("cdwbatchitem")
			}
			for i := range targetIDs {
				targetIDs[i] = NewID("cdwtarget")
			}
			for i := range grantIDs {
				grantIDs[i] = NewID("cdwaccess")
			}
			receiverBindingIDs := make([]string, len(snapshot.Targets))
			for i := range receiverBindingIDs {
				receiverBindingIDs[i] = NewID("cdwreceiverrole")
			}
			return store.CDWDistributionDispatch(ctx, batchID, planID, actor.ID,
				expected, digest, itemIDs, targetIDs, grantIDs, receiverBindingIDs)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}
