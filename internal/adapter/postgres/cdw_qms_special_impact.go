package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"time"

	"github.com/jackc/pgx/v5"
)

func (r *Repository) CDWQMSSpecialEvidenceSource(ctx context.Context, id string) (ports.CDWQMSSpecialEvidenceSource, error) {
	var out ports.CDWQMSSpecialEvidenceSource
	// Policy source MUST be the exact presently effective, dispatched controlled
	// distribution artifact referenced by the immutable special application.
	// Prefer its DOCX, otherwise the exact issued PDF. Never read file latest.
	err := r.Q.QueryRow(ctx, `SELECT blob.storage_key,rel.display_name_snapshot,
 blob.size_bytes,artifact.sha256,rel.id,artifact.format
 FROM cdw_qms_special_authorities special
 JOIN cdw_controlled_releases rel ON rel.id=special.policy_release_id
 JOIN cdw_effective_pointers ptr ON ptr.file_id=rel.file_id
  AND ptr.release_id=rel.id AND ptr.state='active'
 JOIN cdw_release_artifacts artifact ON artifact.release_id=rel.id
  AND artifact.purpose='distribution'
 JOIN cdw_distribution_batch_items item ON item.release_id=rel.id
  AND item.artifact_id=artifact.id AND item.artifact_sha256=artifact.sha256
 JOIN cdw_distribution_batches batch ON batch.id=item.batch_id AND batch.state='dispatched'
 JOIN blobs blob ON blob.id=artifact.blob_id AND blob.state='ready'
  AND blob.sha256=artifact.sha256 AND blob.size_bytes=artifact.size_bytes
 WHERE special.id=$1 AND rel.state='effective'
  AND cdw_qms_special_policy_qualified(special.kind,special.policy_release_id)
 ORDER BY CASE WHEN artifact.format='docx' THEN 0 ELSE 1 END,artifact.created_at DESC
 LIMIT 1`, id).Scan(&out.StorageKey, &out.Name, &out.SizeBytes, &out.SHA256, &out.ReleaseID, &out.Format)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrPolicyAuthorityPending
	}
	return out, err
}

const cdwSpecialImpactCols = `i.id,i.authority_id,i.subject_file_id,subject.name,
 i.policy_file_id,COALESCE(i.old_release_id,''),COALESCE(i.new_release_id,''),
 i.source_kind,i.state,i.detected_at,COALESCE(i.assessment,''),COALESCE(i.disposition,'')`
const cdwSpecialImpactJoin = ` FROM cdw_qms_special_policy_impacts i
 JOIN files subject ON subject.id=i.subject_file_id AND subject.deleted_at IS NULL`

func scanCDWQMSImpact(row rowScanner) (ports.CDWQMSSpecialPolicyImpact, error) {
	var result ports.CDWQMSSpecialPolicyImpact
	var created time.Time
	err := row.Scan(&result.ID, &result.AuthorityID, &result.SubjectFileID, &result.SubjectName,
		&result.PolicyFileID, &result.OldReleaseID, &result.NewReleaseID, &result.SourceKind,
		&result.State, &created, &result.Assessment, &result.Disposition)
	if err == nil {
		result.DetectedAt = created.UTC().Format(time.RFC3339Nano)
	}
	return result, err
}
func (r *Repository) CDWQMSSpecialImpacts(ctx context.Context, actor string, limit int) ([]ports.CDWQMSSpecialPolicyImpact, error) {
	rows, err := r.Q.Query(ctx, `SELECT `+cdwSpecialImpactCols+cdwSpecialImpactJoin+`
 WHERE EXISTS(SELECT 1 FROM cdw_business_role_bindings bind JOIN users u ON u.id=bind.user_id
  WHERE bind.user_id=$1 AND bind.role='document_control'
   AND (bind.file_id=i.subject_file_id OR bind.file_id IS NULL)
   AND bind.department_id IS NULL AND bind.revoked_at IS NULL AND u.disabled_at IS NULL
   AND bind.valid_from<=clock_timestamp() AND (bind.expires_at IS NULL OR bind.expires_at>clock_timestamp()))
 ORDER BY CASE WHEN i.state='open' THEN 0 ELSE 1 END,i.detected_at DESC,i.id DESC LIMIT $2`, actor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWQMSSpecialPolicyImpact{}
	for rows.Next() {
		item, e := scanCDWQMSImpact(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
func (r *Repository) CDWQMSSpecialImpactFiles(ctx context.Context, id string) (string, string, error) {
	var subject, policy string
	err := r.Q.QueryRow(ctx, `SELECT subject_file_id,policy_file_id FROM cdw_qms_special_policy_impacts WHERE id=$1`, id).Scan(&subject, &policy)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", domain.ErrNotFound
	}
	return subject, policy, err
}
func (r *Repository) CDWQMSSpecialAssessImpact(ctx context.Context, id, actor, disposition, reason string) (ports.CDWQMSSpecialPolicyImpact, error) {
	var out ports.CDWQMSSpecialPolicyImpact
	var proposer, fileID, state string
	err := r.Q.QueryRow(ctx, `SELECT a.proposed_by,i.subject_file_id,i.state
 FROM cdw_qms_special_policy_impacts i
 JOIN cdw_qms_special_authorities a ON a.id=i.authority_id
 WHERE i.id=$1 FOR UPDATE OF i`, id).Scan(&proposer, &fileID, &state)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if proposer == actor {
		return out, domain.ErrForbidden
	}
	if state != "open" {
		return out, domain.ErrConflict
	}
	if _, err = r.CDWControlRole(ctx, actor, "document_control", fileID); err != nil {
		return out, err
	}
	_, err = r.Q.Exec(ctx, `UPDATE cdw_qms_special_policy_impacts SET
 state='assessed',assessment=$2,disposition=$3,assessed_by=$4,assessed_at=clock_timestamp()
 WHERE id=$1 AND state='open'`, id, reason, disposition, actor)
	if err != nil {
		return out, err
	}
	return scanCDWQMSImpact(r.Q.QueryRow(ctx, `SELECT `+cdwSpecialImpactCols+cdwSpecialImpactJoin+` WHERE i.id=$1`, id))
}
