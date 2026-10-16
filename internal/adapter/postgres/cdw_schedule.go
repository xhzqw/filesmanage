package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"time"

	"github.com/jackc/pgx/v5"
)

// CDWScheduleGet deliberately returns not_configured for a known release,
// rather than implying that a planned time is permission to auto-activate.
func (r *Repository) CDWScheduleGet(ctx context.Context, releaseID string) (ports.CDWActivationSchedule, error) {
	var out ports.CDWActivationSchedule
	var next *time.Time
	var raw []byte
	err := r.Q.QueryRow(ctx, `SELECT rel.id,rel.revision,COALESCE(s.sponsor_id,''),
 COALESCE(s.status,'not_configured'),COALESCE(s.revision,0),
 COALESCE(s.next_attempt_at,rel.planned_effective_at),COALESCE(s.attempts,0),
 COALESCE(s.last_blockers,'[]'::jsonb),COALESCE(s.last_error,'')
 FROM cdw_controlled_releases rel LEFT JOIN cdw_activation_schedules s ON s.release_id=rel.id
 WHERE rel.id=$1`, releaseID).Scan(&out.ReleaseID, &out.ReleaseRevision, &out.SponsorID,
		&out.Status, &out.Revision, &next, &out.Attempts, &raw, &out.LastError)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if err = json.Unmarshal(raw, &out.LastBlockers); err != nil {
		return out, err
	}
	if next != nil {
		out.NextAttemptAt = next.UTC().Format(time.RFC3339Nano)
	}
	return out, nil
}

func (r *Repository) CDWScheduleConfigure(ctx context.Context, releaseID, actor string,
	expected int64, enable bool) (ports.CDWActivationSchedule, error) {
	var out ports.CDWActivationSchedule
	var fileID, lockedID, state string
	var actual int64
	var planned *time.Time
	err := r.Q.QueryRow(ctx, `SELECT file_id FROM cdw_controlled_releases WHERE id=$1`, releaseID).Scan(&fileID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	// Same lock order as activation: file -> release -> schedule.
	err = r.Q.QueryRow(ctx, `SELECT id FROM files WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, fileID).Scan(&lockedID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrConflict
	}
	if err != nil {
		return out, err
	}
	err = r.Q.QueryRow(ctx, `SELECT state,revision,planned_effective_at
 FROM cdw_controlled_releases WHERE id=$1 FOR UPDATE`, releaseID).Scan(&state, &actual, &planned)
	if err != nil {
		return out, err
	}
	if actual != expected {
		return out, domain.ErrVersionConflict
	}
	if _, err = r.CDWControlRole(ctx, actor, "document_control", fileID); err != nil {
		return out, err
	}
	if state != "issued_pending" || planned == nil {
		return out, domain.ErrConflict
	}
	if enable {
		var dispatched bool
		err = r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_distribution_batch_items bi
   JOIN cdw_distribution_batches b ON b.id=bi.batch_id AND b.state='dispatched'
   JOIN cdw_distribution_plans p ON p.id=b.plan_id AND p.state='dispatched'
   WHERE bi.release_id=$1)`, releaseID).Scan(&dispatched)
		if err != nil {
			return out, err
		}
		if !dispatched {
			return out, domain.ErrConflict
		}
	}
	target := "cancelled"
	if enable {
		target = "enabled"
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_activation_schedules
 (release_id,sponsor_id,status,next_attempt_at)
 VALUES($1,$2,$3,$4)
 ON CONFLICT(release_id) DO UPDATE SET sponsor_id=EXCLUDED.sponsor_id,
 status=EXCLUDED.status,revision=cdw_activation_schedules.revision+1,
 next_attempt_at=EXCLUDED.next_attempt_at,lease_token=NULL,lease_until=NULL,
 last_blockers='[]'::jsonb,last_error=NULL,changed_at=clock_timestamp()`,
		releaseID, actor, target, *planned)
	if err != nil {
		return out, err
	}
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_controlled_releases SET revision=revision+1
 WHERE id=$1 AND revision=$2 AND state='issued_pending'`, releaseID, expected)
	if err != nil {
		return out, err
	}
	if tag.RowsAffected() != 1 {
		return out, domain.ErrVersionConflict
	}
	return r.CDWScheduleGet(ctx, releaseID)
}

// Claim one due schedule with a short database transaction. No advisory
// singleton, in-memory timer identity or long-held transaction is required.
func (r *Repository) CDWClaimDueActivation(ctx context.Context) (ports.CDWDueActivation, bool, error) {
	var out ports.CDWDueActivation
	tx, err := r.DB.Begin(ctx)
	if err != nil {
		return out, false, err
	}
	defer tx.Rollback(ctx)
	err = tx.QueryRow(ctx, `SELECT s.release_id,s.sponsor_id,rel.revision
 FROM cdw_activation_schedules s
 JOIN cdw_controlled_releases rel ON rel.id=s.release_id
 WHERE s.status='enabled' AND s.next_attempt_at<=now()
 AND (s.lease_until IS NULL OR s.lease_until<=now())
 ORDER BY s.next_attempt_at,s.release_id
 FOR UPDATE OF s SKIP LOCKED LIMIT 1`).Scan(&out.ReleaseID, &out.SponsorID, &out.ReleaseRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, false, nil
	}
	if err != nil {
		return out, false, err
	}
	out.LeaseToken = domain.NewID("cdwautoclaim")
	_, err = tx.Exec(ctx, `UPDATE cdw_activation_schedules
 SET lease_token=$2,lease_until=clock_timestamp()+interval '2 minutes',
 attempts=attempts+1,changed_at=clock_timestamp()
 WHERE release_id=$1`, out.ReleaseID, out.LeaseToken)
	if err != nil {
		return out, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, false, err
	}
	return out, true, nil
}

func (r *Repository) CDWScheduleVerifyLease(ctx context.Context, releaseID, actor, token string) (bool, error) {
	var fileID, lockedID string
	err := r.Q.QueryRow(ctx, `SELECT file_id FROM cdw_controlled_releases WHERE id=$1`, releaseID).Scan(&fileID)
	if err != nil {
		return false, err
	}
	err = r.Q.QueryRow(ctx, `SELECT id FROM files WHERE id=$1 FOR UPDATE`, fileID).Scan(&lockedID)
	if err != nil {
		return false, err
	}
	var sponsor, status string
	var leaseUntil *time.Time
	err = r.Q.QueryRow(ctx, `SELECT sponsor_id,status,lease_until FROM cdw_activation_schedules
	WHERE release_id=$1 AND lease_token=$2 FOR UPDATE`, releaseID, token).
		Scan(&sponsor, &status, &leaseUntil)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return sponsor == actor && status == "enabled" && leaseUntil != nil && leaseUntil.After(time.Now()), nil
}

func (r *Repository) CDWScheduleFinish(ctx context.Context, releaseID, token, status string,
	blockers []string) (bool, error) {
	if status != "completed" && status != "retry" && status != "paused" {
		return false, domain.ErrInvalidInput
	}
	raw, err := json.Marshal(blockers)
	if err != nil {
		return false, err
	}
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_activation_schedules SET
 status=CASE WHEN $3='retry' THEN 'enabled' ELSE $3 END,
 next_attempt_at=CASE WHEN $3='retry' THEN
 clock_timestamp()+LEAST(interval '1 hour',interval '5 minutes'*power(2,LEAST(attempts::int,4)))
 ELSE next_attempt_at END,
 lease_token=NULL,lease_until=NULL,last_blockers=$4::jsonb,
 last_error=NULL,revision=revision+1,changed_at=clock_timestamp()
 WHERE release_id=$1 AND lease_token=$2 AND status='enabled'`,
		releaseID, token, status, string(raw))
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// Error handling after a failed application transaction must not keep a
// claim permanently busy; forbidden/stale sponsors are paused, not retried.
func (r *Repository) CDWScheduleFailClaim(ctx context.Context, releaseID, token string, permanent bool) (bool, error) {
	tx, err := r.DB.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var sponsor string
	err = tx.QueryRow(ctx, `SELECT sponsor_id FROM cdw_activation_schedules
 WHERE release_id=$1 AND lease_token=$2 AND status='enabled' FOR UPDATE`, releaseID, token).Scan(&sponsor)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	status := "enabled"
	reason := "temporary_scheduler_error"
	if permanent {
		status = "paused"
		reason = "authorization_or_release_changed"
	}
	_, err = tx.Exec(ctx, `INSERT INTO cdw_activation_attempts
 (id,release_id,actor_id,outcome,trigger_kind,blockers,idempotency_key)
 VALUES($1,$2,$3,'failed','scheduler',jsonb_build_array($4::text),$5)`,
		domain.NewID("cdwschedfail"), releaseID, sponsor, reason, token)
	if err != nil {
		return false, err
	}
	tag, err := tx.Exec(ctx, `UPDATE cdw_activation_schedules SET
 status=$3,lease_token=NULL,lease_until=NULL,
 next_attempt_at=clock_timestamp()+interval '10 minutes',
 last_error=$4,revision=revision+1,changed_at=clock_timestamp()
 WHERE release_id=$1 AND lease_token=$2 AND status='enabled'`, releaseID, token, status, reason)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() != 1 {
		return false, domain.ErrVersionConflict
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}
