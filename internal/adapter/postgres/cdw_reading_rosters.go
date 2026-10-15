package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

func (r *Repository) CDWReadingTargetFile(ctx context.Context, id string) (string, error) {
	return r.CDWReceiptTargetFile(ctx, id)
}
func (r *Repository) CDWReadingAssignmentFile(ctx context.Context, id string) (string, error) {
	var fileID string
	err := r.Q.QueryRow(ctx, `SELECT rel.file_id FROM cdw_reading_assignments a
 JOIN cdw_distribution_batch_items bi ON bi.id=a.batch_item_id
 JOIN cdw_controlled_releases rel ON rel.id=bi.release_id WHERE a.id=$1`, id).Scan(&fileID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	return fileID, err
}
func (r *Repository) CDWReadingCreateRoster(ctx context.Context, id, targetID, actor, digest string,
	readers, assignments, grants []string) (ports.CDWReadingRoster, error) {
	var out ports.CDWReadingRoster
	if len(readers) < 1 || len(readers) != len(assignments) || len(readers) != len(grants) {
		return out, domain.ErrInvalidInput
	}
	var batchID, deptID, receiver, fileID, batchItemID, artifactID, releaseID, sha, state, batchState string
	var receiptID *string
	var required bool
	err := r.Q.QueryRow(ctx, `SELECT t.batch_id,t.department_id,t.designated_receiver_id,
 rel.file_id,bi.id,bi.artifact_id,bi.release_id,bi.artifact_sha256,
 h.current_receipt_id,t.validity_state,b.state,req.reading_required
 FROM cdw_distribution_targets t JOIN cdw_distribution_batches b ON b.id=t.batch_id
 JOIN cdw_distribution_batch_items bi ON bi.batch_id=b.id AND bi.ordinal=1
 JOIN cdw_controlled_releases rel ON rel.id=bi.release_id
 JOIN cdw_target_receipt_heads h ON h.target_id=t.id
 JOIN cdw_target_item_requirements req ON req.target_id=t.id AND req.batch_item_id=bi.id
 WHERE t.id=$1 FOR UPDATE OF t,h`, targetID).
		Scan(&batchID, &deptID, &receiver, &fileID, &batchItemID, &artifactID, &releaseID,
			&sha, &receiptID, &state, &batchState, &required)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if actor != receiver {
		return out, domain.ErrForbidden
	}
	if state != "active" || batchState != "dispatched" || receiptID == nil || !required {
		return out, domain.ErrConflict
	}
	var role string
	err = r.Q.QueryRow(ctx, `SELECT b.id FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
 WHERE b.user_id=$1 AND b.department_id=$2 AND b.role='department_receiver'
 AND b.revoked_at IS NULL AND b.valid_from<=now()
 AND (b.expires_at IS NULL OR b.expires_at>now())
 AND u.disabled_at IS NULL AND u.department_id=$2 LIMIT 1 FOR SHARE OF b,u`,
		actor, deptID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrForbidden
	}
	if err != nil {
		return out, err
	}
	var existing bool
	err = r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_reading_rosters WHERE target_id=$1)`, targetID).Scan(&existing)
	if err != nil {
		return out, err
	}
	if existing {
		return out, domain.ErrConflict
	}
	// The exact target and approved release SHA are persisted with the roster.
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_reading_rosters
 (id,target_id,revision,digest_sha256,created_by) VALUES($1,$2,1,$3,$4)`,
		id, targetID, digest, actor)
	if err != nil {
		return out, err
	}
	for i, userID := range readers {
		var found string
		err = r.Q.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 AND department_id=$2
 AND disabled_at IS NULL FOR SHARE`, userID, deptID).Scan(&found)
		if errors.Is(err, pgx.ErrNoRows) {
			return out, domain.ErrForbidden
		}
		if err != nil {
			return out, err
		}
		_, err = r.Q.Exec(ctx, `INSERT INTO cdw_reading_assignments
 (id,roster_id,target_id,batch_id,batch_item_id,artifact_sha256,user_id,state,required)
 VALUES($1,$2,$3,$4,$5,$6,$7,'assigned',true)`,
			assignments[i], id, targetID, batchID, batchItemID, sha, userID)
		if err != nil {
			return out, err
		}
		_, err = r.Q.Exec(ctx, `INSERT INTO cdw_release_access_grants
 (id,release_id,artifact_id,batch_item_id,user_id,actions,source_target_id,granted_by)
 VALUES($1,$2,$3,$4,$5,ARRAY['preview','read_confirm','download']::text[],$6,$7)`,
			grants[i], releaseID, artifactID, batchItemID, userID, targetID, actor)
		if err != nil {
			return out, err
		}
	}
	return ports.CDWReadingRoster{ID: id, TargetID: targetID, BatchID: batchID, FileID: fileID,
		DepartmentID: deptID, DigestSHA256: digest, AssignedCount: len(readers)}, nil
}
func (r *Repository) CDWReadingInbox(ctx context.Context, actor string, limit int) ([]ports.CDWReadingAssignment, error) {
	rows, err := r.Q.Query(ctx, `SELECT a.id,a.roster_id,a.target_id,a.batch_id,rel.file_id,
 rel.display_name_snapshot,rel.controlled_revision,a.artifact_sha256,a.user_id,a.state
 FROM cdw_reading_assignments a
 JOIN cdw_distribution_targets t ON t.id=a.target_id
 JOIN cdw_distribution_batches b ON b.id=a.batch_id AND b.state='dispatched'
 JOIN cdw_distribution_batch_items i ON i.id=a.batch_item_id
 JOIN cdw_controlled_releases rel ON rel.id=i.release_id
 JOIN users u ON u.id=a.user_id AND u.disabled_at IS NULL
 JOIN cdw_target_receipt_heads h ON h.target_id=t.id AND h.current_receipt_id IS NOT NULL
 WHERE a.user_id=$1 AND u.department_id=t.department_id AND t.validity_state='active'
 ORDER BY a.assigned_at DESC,a.id DESC LIMIT $2`, actor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWReadingAssignment{}
	for rows.Next() {
		var a ports.CDWReadingAssignment
		if err = rows.Scan(&a.ID, &a.RosterID, &a.TargetID, &a.BatchID, &a.FileID,
			&a.FileName, &a.RevisionLabel, &a.ArtifactSHA256, &a.UserID, &a.State); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
