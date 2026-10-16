package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
	"time"
)

func (r *Repository) CDWReadingConfirm(ctx context.Context, id, actor, eventID, statement string) (ports.CDWReadingConfirmation, error) {
	var out ports.CDWReadingConfirmation
	var state, sha, dept, blobState, batchState string
	var receiptID *string
	err := r.Q.QueryRow(ctx, `SELECT a.state,a.artifact_sha256,t.department_id,h.current_receipt_id,
 b.state,t.validity_state FROM cdw_reading_assignments a
 JOIN cdw_distribution_targets t ON t.id=a.target_id
 JOIN cdw_target_receipt_heads h ON h.target_id=t.id
 JOIN cdw_distribution_batches b ON b.id=a.batch_id
 WHERE a.id=$1 AND a.user_id=$2 FOR UPDATE OF a,t`, id, actor).
		Scan(&state, &sha, &dept, &receiptID, &batchState, &blobState)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrForbidden
	}
	if err != nil {
		return out, err
	}
	if state != "opened" {
		return out, domain.ErrConflict
	}
	if batchState != "dispatched" || blobState != "active" || receiptID == nil {
		return out, domain.ErrConflict
	}
	var valid bool
	err = r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_reading_assignments a
 JOIN users u ON u.id=a.user_id AND u.disabled_at IS NULL
 JOIN cdw_release_access_grants g ON g.user_id=a.user_id
 AND g.source_target_id=a.target_id AND g.batch_item_id=a.batch_item_id
 WHERE a.id=$1 AND a.user_id=$2 AND u.department_id=$3
 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>now())
 AND 'read_confirm'=ANY(g.actions)
 AND EXISTS (SELECT 1 FROM cdw_reading_events opened
 WHERE opened.assignment_id=a.id AND opened.actor_id=$2
 AND opened.kind='opened' AND opened.artifact_sha256=a.artifact_sha256))`, id, actor, dept).Scan(&valid)
	if err != nil {
		return out, err
	}
	if !valid {
		return out, domain.ErrForbidden
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_reading_events
 (id,assignment_id,actor_id,kind,artifact_sha256,statement_snapshot)
 VALUES($1,$2,$3,'confirmed',$4,$5)`, eventID, id, actor, sha, statement)
	if err != nil {
		return out, err
	}
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_reading_assignments
 SET state='confirmed',confirmed_at=clock_timestamp()
 WHERE id=$1 AND user_id=$2 AND state='opened'`, id, actor)
	if err != nil {
		return out, err
	}
	if tag.RowsAffected() != 1 {
		return out, domain.ErrConflict
	}
	var at time.Time
	err = r.Q.QueryRow(ctx, `SELECT confirmed_at FROM cdw_reading_assignments WHERE id=$1`, id).Scan(&at)
	if err != nil {
		return out, err
	}
	return ports.CDWReadingConfirmation{AssignmentID: id, EventID: eventID, ActorID: actor,
		ArtifactSHA256: sha, State: "confirmed", ConfirmedAt: at.UTC().Format(time.RFC3339Nano)}, nil
}

// A completed full-document transfer is required before an independent
// personal reading declaration. Re-validate the exact artifact and grant
// while the assignment row is locked.
func (r *Repository) CDWReadingMarkOpened(ctx context.Context, id, actor, eventID string) (bool, error) {
	var state, sha string
	err := r.Q.QueryRow(ctx, `SELECT a.state,a.artifact_sha256 FROM cdw_reading_assignments a
 WHERE a.id=$1 AND a.user_id=$2 FOR UPDATE OF a`, id, actor).Scan(&state, &sha)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, domain.ErrForbidden
	}
	if err != nil {
		return false, err
	}
	if state == "opened" || state == "confirmed" {
		return false, nil
	}
	if state != "assigned" {
		return false, domain.ErrConflict
	}
	if _, err = r.CDWReadingSource(ctx, id, actor); err != nil {
		return false, err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_reading_events
 (id,assignment_id,actor_id,kind,artifact_sha256,statement_snapshot)
 VALUES($1,$2,$3,'opened',$4,$5)`,
		eventID, id, actor, sha, "受控发行稿完整传送成功；不代表实际阅读或培训完成")
	if err != nil {
		return false, err
	}
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_reading_assignments SET state='opened'
 WHERE id=$1 AND user_id=$2 AND state='assigned'`, id, actor)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() != 1 {
		return false, domain.ErrConflict
	}
	return true, nil
}

func (r *Repository) CDWReadingSource(ctx context.Context, id, actor string) (ports.CDWBranchSource, error) {
	var out ports.CDWBranchSource
	err := r.Q.QueryRow(ctx, `SELECT bl.storage_key,r.display_name_snapshot,bl.size_bytes
 FROM cdw_reading_assignments a
 JOIN cdw_distribution_targets t ON t.id=a.target_id
 JOIN cdw_target_receipt_heads h ON h.target_id=t.id AND h.current_receipt_id IS NOT NULL
 JOIN cdw_distribution_batches b ON b.id=a.batch_id AND b.state='dispatched'
 JOIN cdw_distribution_batch_items i ON i.id=a.batch_item_id
 JOIN cdw_controlled_releases r ON r.id=i.release_id
 JOIN cdw_release_artifacts artifact ON artifact.id=i.artifact_id
 AND artifact.sha256=a.artifact_sha256 AND artifact.purpose='distribution'
 JOIN blobs bl ON bl.id=artifact.blob_id
 JOIN users u ON u.id=a.user_id AND u.disabled_at IS NULL
 WHERE a.id=$1 AND a.user_id=$2 AND t.validity_state='active' AND u.department_id=t.department_id
 AND bl.state='ready' AND bl.sha256=i.artifact_sha256 AND bl.size_bytes=artifact.size_bytes
 AND EXISTS(SELECT 1 FROM cdw_release_access_grants g
 WHERE g.source_target_id=t.id AND g.batch_item_id=i.id AND g.user_id=a.user_id
 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>now())
 AND 'preview'=ANY(g.actions))`, id, actor).
		Scan(&out.StorageKey, &out.Name, &out.SizeBytes)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrForbidden
	}
	return out, err
}
func (r *Repository) CDWReadingEvent(ctx context.Context, actor, kind, id, key string, result any) error {
	raw, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_domain_events
 (aggregate_kind,aggregate_id,event_kind,actor_id,request_id,details)
 VALUES('reading_assignment',$1,$2,$3,$4,$5)`, id, kind, actor, key, string(raw))
	if err != nil {
		return err
	}
	sum := sha256.Sum256([]byte("reading|" + actor + "|" + kind + "|" + id + "|" + key))
	_, err = r.Q.Exec(ctx, `INSERT INTO outbox_jobs(id,kind,payload)
 VALUES($1,'cdw.reading.changed',$2)`, "cdw_evt_"+hex.EncodeToString(sum[:]), string(raw))
	return err
}
