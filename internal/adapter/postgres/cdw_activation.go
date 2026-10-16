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

// CDWActivateRelease serializes all effective-pointer writes on the file row.
// It must only execute in the caller's transaction (which also writes audit,
// immutable domain event, idempotency response and outbox).
func (r *Repository) CDWActivateRelease(ctx context.Context, attemptID, releaseID, actor string,
	expected int64, key string) (ports.CDWActivationDecision, error) {
	return r.CDWActivateReleaseWithTrigger(ctx, attemptID, releaseID, actor, expected, key, "manual")
}

func (r *Repository) CDWActivateReleaseWithTrigger(ctx context.Context, attemptID, releaseID, actor string,
	expected int64, key, trigger string) (ports.CDWActivationDecision, error) {
	if trigger != "manual" && trigger != "scheduler" {
		return ports.CDWActivationDecision{}, domain.ErrInvalidInput
	}
	out := ports.CDWActivationDecision{ReleaseID: releaseID, Outcome: "blocked", Blockers: []string{}}
	var fileID string
	err := r.Q.QueryRow(ctx, `SELECT file_id FROM cdw_controlled_releases WHERE id=$1`, releaseID).Scan(&fileID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	out.FileID = fileID
	// File lock is the universal per-file serialization point, including when
	// no effective-pointer row exists yet.
	var activeFile string
	err = r.Q.QueryRow(ctx, `SELECT id FROM files WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, fileID).Scan(&activeFile)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrConflict
	}
	if err != nil {
		return out, err
	}
	var state string
	var planned *time.Time
	var supersedes *string
	var policy []byte
	err = r.Q.QueryRow(ctx, `SELECT state,revision,planned_effective_at,supersedes_release_id,policy_snapshot
 FROM cdw_controlled_releases WHERE id=$1 AND file_id=$2 FOR UPDATE`, releaseID, fileID).
		Scan(&state, &out.Revision, &planned, &supersedes, &policy)
	if err != nil {
		return out, err
	}
	if out.Revision != expected || state != "issued_pending" {
		return out, domain.ErrVersionConflict
	}
	if _, err = r.CDWControlRole(ctx, actor, "document_control", fileID); err != nil {
		return out, err
	}
	var approvalCandidateID string
	err = r.Q.QueryRow(ctx, `SELECT approved_candidate_id FROM cdw_controlled_releases WHERE id=$1`, releaseID).Scan(&approvalCandidateID)
	if err != nil {
		return out, err
	}
	current, err := r.cdwQMSCandidatePolicyCurrent(ctx, approvalCandidateID)
	if err != nil {
		return out, err
	}
	if !current {
		out.Blockers = append(out.Blockers, "qms_policy_authority_not_current")
	}
	var policyFlags struct {
		Version                     string `json:"version"`
		RequiresScopeApproval       bool   `json:"requiresScopeApproval"`
		RequiresDepartmentReceipt   bool   `json:"requiresDepartmentReceipt"`
		RequiresReadingConfirmation bool   `json:"requiresReadingConfirmation"`
	}
	if err = json.Unmarshal(policy, &policyFlags); err != nil {
		return out, err
	}
	if policyFlags.Version != "cdw-g8-v1" ||
		!policyFlags.RequiresScopeApproval || !policyFlags.RequiresDepartmentReceipt ||
		!policyFlags.RequiresReadingConfirmation {
		out.Blockers = append(out.Blockers, "unsupported_activation_policy")
	}
	if planned != nil && planned.After(time.Now()) {
		out.Blockers = append(out.Blockers, "planned_effective_time_not_reached")
	}
	// Both plan and batch must be frozen to the same digest, independently
	// scope-approved, and bound to a verified immutable distribution artifact.
	var batchID, planID, digest, batchState, planState, artifactID, sha string
	err = r.Q.QueryRow(ctx, `SELECT b.id,p.id,b.plan_digest_sha256,b.state,p.state,bi.artifact_id,bi.artifact_sha256
 FROM cdw_distribution_batch_items bi
 JOIN cdw_distribution_batches b ON b.id=bi.batch_id
 JOIN cdw_distribution_plans p ON p.id=b.plan_id AND p.digest_sha256=b.plan_digest_sha256
 JOIN cdw_distribution_scope_approvals ap ON ap.plan_id=p.id
 AND ap.plan_digest_sha256=p.digest_sha256
 JOIN cdw_release_artifact_verifications v ON v.release_id=bi.release_id
 AND v.verified_artifact_id=bi.artifact_id AND v.source_sha256=bi.artifact_sha256
 JOIN cdw_release_artifacts a ON a.id=bi.artifact_id AND a.release_id=bi.release_id
 AND a.purpose='distribution' AND a.format='docx' AND a.sha256=bi.artifact_sha256
 JOIN blobs bl ON bl.id=a.blob_id AND bl.state='ready'
 AND bl.sha256=a.sha256 AND bl.size_bytes=a.size_bytes
 WHERE bi.release_id=$1 AND bi.ordinal=1
 ORDER BY b.dispatched_at DESC LIMIT 1`, releaseID).
		Scan(&batchID, &planID, &digest, &batchState, &planState, &artifactID, &sha)
	if errors.Is(err, pgx.ErrNoRows) {
		out.Blockers = append(out.Blockers, "verified_dispatched_manifest_missing")
	} else if err != nil {
		return out, err
	} else if batchState != "dispatched" || planState != "dispatched" {
		out.Blockers = append(out.Blockers, "distribution_not_dispatched")
	}
	if batchID != "" && batchState == "dispatched" && planState == "dispatched" {
		var total, invalid, receiptsMissing, readersMissing, papersMissing int
		err = r.Q.QueryRow(ctx, `SELECT count(*),
 count(*) FILTER(WHERE t.validity_state<>'active'),
 count(*) FILTER(WHERE req.receipt_required AND
  (head.current_receipt_id IS NULL OR rec.manifest_sha256 IS DISTINCT FROM $2)),
 count(*) FILTER(WHERE req.reading_required AND
  (NOT EXISTS(SELECT 1 FROM cdw_reading_rosters roster WHERE roster.target_id=t.id)
   OR NOT EXISTS(SELECT 1 FROM cdw_reading_assignments a WHERE a.target_id=t.id
    AND a.batch_item_id=req.batch_item_id AND a.required)
   OR EXISTS(SELECT 1 FROM cdw_reading_assignments a
     JOIN users u ON u.id=a.user_id
     WHERE a.target_id=t.id AND a.batch_item_id=req.batch_item_id AND a.required
     AND (a.state<>'confirmed' OR a.confirmed_at IS NULL OR
      NOT EXISTS(SELECT 1 FROM cdw_reading_events e WHERE e.assignment_id=a.id
       AND e.kind='confirmed' AND e.actor_id=a.user_id AND e.artifact_sha256=a.artifact_sha256)
      OR u.disabled_at IS NOT NULL
      OR u.department_id IS DISTINCT FROM t.department_id)))),
 count(*) FILTER(WHERE pt.paper_quantity>0 AND
  (NOT EXISTS(SELECT 1 FROM cdw_copy_issue_lots lot WHERE lot.target_id=t.id
   AND lot.batch_item_id=req.batch_item_id AND lot.state='frozen'
   AND lot.issued_qty=pt.paper_quantity)
   OR (SELECT count(*) FROM cdw_controlled_copies c
     JOIN cdw_copy_issue_lots lot ON lot.id=c.lot_id
     WHERE lot.target_id=t.id AND lot.batch_item_id=req.batch_item_id)<>pt.paper_quantity))
 FROM cdw_distribution_targets t
 JOIN cdw_target_item_requirements req ON req.target_id=t.id
 JOIN cdw_distribution_plan_targets pt ON pt.plan_id=t.plan_id AND pt.department_id=t.department_id
 LEFT JOIN cdw_target_receipt_heads head ON head.target_id=t.id
 LEFT JOIN cdw_department_receipts rec ON rec.id=head.current_receipt_id
 WHERE t.batch_id=$1`, batchID, digest).
			Scan(&total, &invalid, &receiptsMissing, &readersMissing, &papersMissing)
		if err != nil {
			return out, err
		}
		if total < 1 || invalid > 0 {
			out.Blockers = append(out.Blockers, "distribution_targets_invalid")
		}
		if receiptsMissing > 0 {
			out.Blockers = append(out.Blockers, "department_receipts_incomplete")
		}
		if readersMissing > 0 {
			out.Blockers = append(out.Blockers, "required_readings_incomplete")
		}
		if papersMissing > 0 {
			out.Blockers = append(out.Blockers, "paper_issue_not_frozen")
		}
	}
	var pointerState string
	var previous *string
	err = r.Q.QueryRow(ctx, `SELECT state,release_id,revision FROM cdw_effective_pointers WHERE file_id=$1 FOR UPDATE`, fileID).
		Scan(&pointerState, &previous, &out.PointerRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		out.PointerRevision = 0
	} else if err != nil {
		return out, err
	}
	if previous != nil {
		out.PriorReleaseID = *previous
	}
	if pointerState == "active" && previous != nil {
		if *previous == releaseID || supersedes == nil || *supersedes != *previous {
			out.Blockers = append(out.Blockers, "supersession_lineage_mismatch")
		} else {
			var outstanding int
			err = r.Q.QueryRow(ctx, `SELECT count(*) FROM cdw_controlled_copies c
    JOIN cdw_controlled_copy_heads h ON h.copy_id=c.id
    WHERE c.release_id=$1 AND h.state IN ('issued','lost')`, *previous).Scan(&outstanding)
			if err != nil {
				return out, err
			}
			if outstanding > 0 {
				out.Blockers = append(out.Blockers, "previous_paper_copies_outstanding")
			}
		}
	} else if supersedes != nil {
		out.Blockers = append(out.Blockers, "supersession_pointer_missing")
	}
	if len(out.Blockers) > 0 {
		raw, e := json.Marshal(out.Blockers)
		if e != nil {
			return out, e
		}
		_, err = r.Q.Exec(ctx, `INSERT INTO cdw_activation_attempts
  (id,release_id,actor_id,outcome,trigger_kind,blockers,idempotency_key)
  VALUES($1,$2,$3,'blocked',$4,$5::jsonb,$6)`,
			attemptID, releaseID, actor, trigger, string(raw), key)
		return out, err
	}
	// The immutable attempt, pointer, prior release retirement, and new
	// activation all roll back together if any later audit/outbox write fails.
	if previous != nil {
		tag, e := r.Q.Exec(ctx, `UPDATE cdw_controlled_releases SET state='superseded',revision=revision+1
   WHERE id=$1 AND state='effective'`, *previous)
		if e != nil {
			return out, e
		}
		if tag.RowsAffected() != 1 {
			return out, domain.ErrVersionConflict
		}
		_, err = r.Q.Exec(ctx, `UPDATE cdw_release_access_grants SET revoked_at=clock_timestamp()
   WHERE release_id=$1 AND revoked_at IS NULL`, *previous)
		if err != nil {
			return out, err
		}
		_, err = r.Q.Exec(ctx, `UPDATE cdw_distribution_targets SET validity_state='superseded',
   revision=revision+1 WHERE validity_state='active' AND batch_id IN
   (SELECT batch_id FROM cdw_distribution_batch_items WHERE release_id=$1)`, *previous)
		if err != nil {
			return out, err
		}
	}
	var effectiveAt time.Time
	err = r.Q.QueryRow(ctx, `UPDATE cdw_controlled_releases
 SET state='effective',actual_effective_at=clock_timestamp(),revision=revision+1
 WHERE id=$1 AND state='issued_pending' AND revision=$2
 RETURNING actual_effective_at`, releaseID, expected).Scan(&effectiveAt)
	if err != nil {
		return out, err
	}
	if out.PointerRevision == 0 {
		_, err = r.Q.Exec(ctx, `INSERT INTO cdw_effective_pointers(file_id,release_id,state,activated_at)
   VALUES($1,$2,'active',$3)`, fileID, releaseID, effectiveAt)
		out.PointerRevision = 1
	} else {
		tag, e := r.Q.Exec(ctx, `UPDATE cdw_effective_pointers
   SET release_id=$2,state='active',revision=revision+1,activated_at=$3
   WHERE file_id=$1 AND revision=$4`, fileID, releaseID, effectiveAt, out.PointerRevision)
		if e != nil {
			return out, e
		}
		if tag.RowsAffected() != 1 {
			return out, domain.ErrVersionConflict
		}
		out.PointerRevision++
	}
	if err != nil {
		return out, err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_activation_attempts
 (id,release_id,actor_id,outcome,trigger_kind,blockers,idempotency_key)
 VALUES($1,$2,$3,'activated',$4,'[]'::jsonb,$5)`,
		attemptID, releaseID, actor, trigger, key)
	if err != nil {
		return out, err
	}
	// A manual activation supersedes a previously opted-in timer. Do not
	// clear a scheduler lease on the scheduler path: its claim must be
	// finalized atomically by CDWScheduleFinish in the same transaction.
	if trigger == "manual" {
		_, err = r.Q.Exec(ctx, `UPDATE cdw_activation_schedules SET status='completed',
		 lease_token=NULL,lease_until=NULL,revision=revision+1,
		 changed_at=clock_timestamp() WHERE release_id=$1 AND status='enabled'`, releaseID)
		if err != nil {
			return out, err
		}
	}
	at := effectiveAt.UTC().Format(time.RFC3339Nano)
	out.EffectiveAt = &at
	out.Outcome = "activated"
	out.Revision = expected + 1
	return out, nil
}
