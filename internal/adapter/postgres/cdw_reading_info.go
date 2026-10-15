package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

func (r *Repository) CDWReadingTargetInfo(ctx context.Context, targetID, actor string) (ports.CDWReceiptTarget, error) {
	var out ports.CDWReceiptTarget
	err := r.Q.QueryRow(ctx, `SELECT t.id,t.batch_id,rel.file_id,rel.display_name_snapshot,
 rel.controlled_revision,t.department_id,t.designated_receiver_id,b.plan_digest_sha256,
 bi.artifact_sha256,CASE WHEN h.current_receipt_id IS NULL THEN 'awaiting' ELSE 'received' END,
 h.revision FROM cdw_distribution_targets t
 JOIN cdw_distribution_batches b ON b.id=t.batch_id
 JOIN cdw_distribution_batch_items bi ON bi.batch_id=b.id AND bi.ordinal=1
 JOIN cdw_controlled_releases rel ON rel.id=bi.release_id
 JOIN cdw_target_receipt_heads h ON h.target_id=t.id
 JOIN users u ON u.id=t.designated_receiver_id AND u.disabled_at IS NULL
 WHERE t.id=$1 AND t.designated_receiver_id=$2 AND u.department_id=t.department_id
 AND b.state='dispatched' AND t.validity_state='active'`, targetID, actor).
		Scan(&out.TargetID, &out.BatchID, &out.FileID, &out.FileName, &out.RevisionLabel,
			&out.DepartmentID, &out.ReceiverID, &out.ManifestSHA256, &out.ArtifactSHA256,
			&out.State, &out.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrForbidden
	}
	return out, err
}
func (r *Repository) CDWReadingRosterInfo(ctx context.Context, targetID string) (ports.CDWReadingRoster, error) {
	var out ports.CDWReadingRoster
	err := r.Q.QueryRow(ctx, `SELECT ro.id,ro.target_id,t.batch_id,rel.file_id,
 t.department_id,ro.digest_sha256,
 (SELECT COUNT(*) FROM cdw_reading_assignments a WHERE a.roster_id=ro.id AND a.required)
 FROM cdw_reading_rosters ro
 JOIN cdw_distribution_targets t ON t.id=ro.target_id
 JOIN cdw_distribution_batch_items bi ON bi.batch_id=t.batch_id AND bi.ordinal=1
 JOIN cdw_controlled_releases rel ON rel.id=bi.release_id
 WHERE ro.target_id=$1 ORDER BY ro.revision DESC LIMIT 1`, targetID).
		Scan(&out.ID, &out.TargetID, &out.BatchID, &out.FileID, &out.DepartmentID,
			&out.DigestSHA256, &out.AssignedCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	return out, err
}
