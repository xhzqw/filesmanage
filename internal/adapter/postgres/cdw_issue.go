package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
	"time"
)

// Issue is an independently versioned transaction. It does not dispatch
// departments or activate the globally effective pointer.
func (r *Repository) CDWControlIssue(ctx context.Context, id, actor string, expected int64,
	planID, digest string) (ports.CDWControlledRelease, error) {
	var out ports.CDWControlledRelease
	var state, fileID, name, candidateID, label, sha string
	var planned *time.Time
	var rev int64
	err := r.Q.QueryRow(ctx, `SELECT r.state,r.revision,r.file_id,r.display_name_snapshot,
 r.approved_candidate_id,r.controlled_revision,s.sha256,r.planned_effective_at
 FROM cdw_controlled_releases r
 JOIN cdw_approved_candidates c ON c.id=r.approved_candidate_id
 JOIN cdw_approval_subjects s ON s.id=c.subject_id
 WHERE r.id=$1 FOR UPDATE OF r`, id).
		Scan(&state, &rev, &fileID, &name, &candidateID, &label, &sha, &planned)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if state != "ready" || rev != expected {
		return out, domain.ErrVersionConflict
	}
	current, err := r.cdwQMSCandidatePolicyCurrent(ctx, candidateID)
	if err != nil {
		return out, err
	}
	if !current {
		return out, domain.ErrPolicyAuthorityPending
	}
	if _, err = r.CDWControlRole(ctx, actor, "document_control", fileID); err != nil {
		return out, err
	}
	var proven bool
	err = r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_distribution_plans p
 JOIN cdw_distribution_plan_items pi ON pi.plan_id=p.id
 JOIN cdw_distribution_scope_approvals ap ON ap.plan_id=p.id
 JOIN cdw_release_artifacts a ON a.release_id=pi.release_id
 AND a.id=pi.artifact_id AND a.sha256=pi.artifact_sha256
 JOIN cdw_release_artifact_verifications v ON v.verified_artifact_id=a.id
 WHERE p.id=$1 AND pi.release_id=$2 AND p.state='approved'
 AND p.digest_sha256=$3 AND ap.plan_digest_sha256=$3
 AND a.purpose='distribution' AND a.sha256=v.source_sha256)`,
		planID, id, digest).Scan(&proven)
	if err != nil {
		return out, err
	}
	if !proven {
		return out, domain.ErrConflict
	}
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_controlled_releases
 SET state='issued_pending',issued_by=$2,issued_at=clock_timestamp(),revision=revision+1
 WHERE id=$1 AND state='ready' AND revision=$3`, id, actor, expected)
	if err != nil {
		return out, err
	}
	if tag.RowsAffected() != 1 {
		return out, domain.ErrVersionConflict
	}
	out = ports.CDWControlledRelease{ID: id, FileID: fileID, FileName: name,
		CandidateID: candidateID, RevisionLabel: label, SHA256: sha, State: "issued_pending", Revision: rev + 1}
	if planned != nil {
		v := planned.UTC().Format(time.RFC3339Nano)
		out.PlannedEffectiveAt = &v
	}
	return out, nil
}
