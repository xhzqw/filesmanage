package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

// CDWDistributionWithdraw preserves historical batch, receipt and confirmed
// reading facts; it revokes grants and cancels uncompleted reading work. It
// explicitly refuses a release with an effective pointer.
func (r *Repository) CDWDistributionWithdraw(ctx context.Context, evidenceID, planID, actor string,
	expected int64, reason string) (ports.CDWDistributionWithdrawal, error) {
	var out ports.CDWDistributionWithdrawal
	var planState, batchState, releaseState, releaseID, fileID, batchID, manifest string
	var revision int64
	err := r.Q.QueryRow(ctx, `SELECT p.state,p.revision,b.state,b.id,b.plan_digest_sha256,
 rel.id,rel.file_id,rel.state FROM cdw_distribution_plans p
 JOIN cdw_distribution_batches b ON b.plan_id=p.id
 JOIN cdw_distribution_batch_items bi ON bi.batch_id=b.id AND bi.ordinal=1
 JOIN cdw_controlled_releases rel ON rel.id=bi.release_id
 WHERE p.id=$1 FOR UPDATE OF p,b,rel`, planID).
		Scan(&planState, &revision, &batchState, &batchID, &manifest, &releaseID, &fileID, &releaseState)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if planState != "dispatched" || batchState != "dispatched" || revision != expected {
		return out, domain.ErrVersionConflict
	}
	if releaseState != "issued_pending" {
		return out, domain.ErrConflict
	}
	binding, err := r.CDWControlRole(ctx, actor, "document_control", fileID)
	if err != nil {
		return out, err
	}
	var isEffective bool
	err = r.Q.QueryRow(ctx, `SELECT EXISTS(
 SELECT 1 FROM cdw_effective_pointers WHERE file_id=$1 AND state='active')`,
		fileID).Scan(&isEffective)
	if err != nil {
		return out, err
	}
	if isEffective {
		return out, domain.ErrConflict
	}
	grants, err := r.Q.Exec(ctx, `UPDATE cdw_release_access_grants SET revoked_at=clock_timestamp()
 WHERE source_target_id IN(SELECT id FROM cdw_distribution_targets WHERE batch_id=$1)
 AND revoked_at IS NULL`, batchID)
	if err != nil {
		return out, err
	}
	pending, err := r.Q.Exec(ctx, `UPDATE cdw_reading_assignments SET state='cancelled'
 WHERE batch_id=$1 AND state IN('assigned','opened')`, batchID)
	if err != nil {
		return out, err
	}
	targets, err := r.Q.Exec(ctx, `UPDATE cdw_distribution_targets
 SET validity_state='withdrawn',revision=revision+1
 WHERE batch_id=$1 AND validity_state='active'`, batchID)
	if err != nil {
		return out, err
	}
	if targets.RowsAffected() == 0 {
		return out, domain.ErrConflict
	}
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_distribution_batches SET state='withdrawn',
 revision=revision+1 WHERE id=$1 AND state='dispatched'`, batchID)
	if err != nil {
		return out, err
	}
	if tag.RowsAffected() != 1 {
		return out, domain.ErrVersionConflict
	}
	tag, err = r.Q.Exec(ctx, `UPDATE cdw_distribution_plans SET state='cancelled',
 revision=revision+1 WHERE id=$1 AND state='dispatched' AND revision=$2`, planID, expected)
	if err != nil {
		return out, err
	}
	if tag.RowsAffected() != 1 {
		return out, domain.ErrVersionConflict
	}
	tag, err = r.Q.Exec(ctx, `UPDATE cdw_controlled_releases SET state='withdrawn',
 revision=revision+1 WHERE id=$1 AND state='issued_pending'`, releaseID)
	if err != nil {
		return out, err
	}
	if tag.RowsAffected() != 1 {
		return out, domain.ErrVersionConflict
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_distribution_withdrawal_events
 (id,batch_id,plan_id,release_id,actor_id,authority_binding_id,manifest_sha256,
 reason,revoked_grants,cancelled_pending_readers,invalidated_targets)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		evidenceID, batchID, planID, releaseID, actor, binding, manifest, reason,
		grants.RowsAffected(), pending.RowsAffected(), targets.RowsAffected())
	if err != nil {
		return out, err
	}
	return ports.CDWDistributionWithdrawal{
		ID: evidenceID, BatchID: batchID, PlanID: planID, ReleaseID: releaseID, FileID: fileID,
		State: "withdrawn", PlanRevision: expected + 1, ManifestSHA256: manifest,
		RevokedGrants: grants.RowsAffected(), CancelledReaders: pending.RowsAffected(),
		InvalidatedTargets: targets.RowsAffected(), ActorID: actor, Reason: reason,
	}, nil
}
