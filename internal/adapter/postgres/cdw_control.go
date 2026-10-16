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

func (r *Repository) CDWControlRole(ctx context.Context, actor, role, fileID string) (string, error) {
	var id string
	err := r.Q.QueryRow(ctx, `SELECT b.id FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
 WHERE b.user_id=$1 AND b.role=$2 AND (b.file_id=$3 OR b.file_id IS NULL)
 AND b.department_id IS NULL AND b.revoked_at IS NULL
 AND b.valid_from<=now() AND (b.expires_at IS NULL OR b.expires_at>now())
 AND u.disabled_at IS NULL ORDER BY (b.file_id IS NOT NULL) DESC,b.id LIMIT 1 FOR SHARE OF b,u`,
		actor, role, fileID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrForbidden
	}
	return id, err
}
func (r *Repository) CDWControlGrantRole(ctx context.Context, id, userID, fileID, actor string) (string, error) {
	// Serialize independent keys granting the same role to one subject/file.
	if _, err := r.Q.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "cdw:document_control:"+userID+":"+fileID); err != nil {
		return "", err
	}
	var existing string
	err := r.Q.QueryRow(ctx, `SELECT id FROM cdw_business_role_bindings
 WHERE user_id=$1 AND file_id=$2 AND role='document_control' AND revoked_at IS NULL
 AND valid_from<=now() AND (expires_at IS NULL OR expires_at>now())
 LIMIT 1 FOR UPDATE`, userID, fileID).Scan(&existing)
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	tag, err := r.Q.Exec(ctx, `INSERT INTO cdw_business_role_bindings
 (id,user_id,role,file_id,granted_by)
 SELECT $1,u.id,'document_control',f.id,$4 FROM users u
 CROSS JOIN files f WHERE u.id=$2 AND u.disabled_at IS NULL
 AND f.id=$3 AND f.deleted_at IS NULL`, id, userID, fileID, actor)
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() != 1 {
		return "", domain.ErrInvalidInput
	}
	return id, nil
}
func (r *Repository) CDWControlCandidateFile(ctx context.Context, id string) (string, error) {
	var fileID string
	err := r.Q.QueryRow(ctx, `SELECT file_id FROM cdw_approved_candidates WHERE id=$1`, id).Scan(&fileID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	return fileID, err
}
func (r *Repository) CDWControlFile(ctx context.Context, id string) (string, error) {
	var fileID string
	err := r.Q.QueryRow(ctx, "SELECT file_id FROM cdw_controlled_releases WHERE id=$1", id).Scan(&fileID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	return fileID, err
}
func (r *Repository) CDWControlCandidates(ctx context.Context, limit int) ([]ports.CDWApprovedCandidate, error) {
	rows, err := r.Q.Query(ctx, `SELECT c.id,c.file_id,f.name,c.content_sha256,c.approved_at
 FROM cdw_approved_candidates c JOIN files f ON f.id=c.file_id
 WHERE f.deleted_at IS NULL
 ORDER BY c.approved_at DESC,c.id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWApprovedCandidate{}
	for rows.Next() {
		var v ports.CDWApprovedCandidate
		var when time.Time
		if e := rows.Scan(&v.ID, &v.FileID, &v.FileName, &v.SHA256, &when); e != nil {
			return nil, e
		}
		v.ApprovedAt = when.UTC().Format(time.RFC3339Nano)
		out = append(out, v)
	}
	return out, rows.Err()
}
func (r *Repository) CDWControlList(ctx context.Context, fileID string, limit int) ([]ports.CDWControlledRelease, error) {
	rows, err := r.Q.Query(ctx, `SELECT r.id,r.file_id,r.display_name_snapshot,r.approved_candidate_id,
 r.controlled_revision,s.sha256,r.state,r.revision,r.planned_effective_at
 FROM cdw_controlled_releases r
 JOIN cdw_approved_candidates c ON c.id=r.approved_candidate_id
 JOIN cdw_approval_subjects s ON s.id=c.subject_id
 WHERE r.file_id=$1 ORDER BY r.prepared_at DESC,r.id DESC LIMIT $2`, fileID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWControlledRelease{}
	for rows.Next() {
		var item ports.CDWControlledRelease
		var at *time.Time
		if e := rows.Scan(&item.ID, &item.FileID, &item.FileName, &item.CandidateID, &item.RevisionLabel,
			&item.SHA256, &item.State, &item.Revision, &at); e != nil {
			return nil, e
		}
		if at != nil {
			v := at.UTC().Format(time.RFC3339Nano)
			item.PlannedEffectiveAt = &v
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
func (r *Repository) CDWControlPrepare(ctx context.Context, id, artifactID, candidateID, label, actor, authorityID string, planned *string) (ports.CDWControlledRelease, error) {
	var result ports.CDWControlledRelease
	var when *time.Time
	if planned != nil {
		parsed, err := time.Parse(time.RFC3339, *planned)
		if err != nil {
			return result, domain.ErrInvalidInput
		}
		utc := parsed.UTC()
		when = &utc
	}
	var fileID, name, sha, blobID, approvalState string
	var size int64
	err := r.Q.QueryRow(ctx, `SELECT c.file_id,f.name,c.content_sha256,s.blob_id,s.size_bytes,a.state
 FROM cdw_approved_candidates c JOIN files f ON f.id=c.file_id
 JOIN cdw_approval_subjects s ON s.id=c.subject_id
 JOIN cdw_formal_approval_instances a ON a.id=c.approval_instance_id
 JOIN blobs b ON b.id=s.blob_id
 WHERE c.id=$1 AND f.deleted_at IS NULL AND b.state='ready'
 AND b.sha256=s.sha256 AND c.content_sha256=s.sha256
 AND b.size_bytes=s.size_bytes`, candidateID).
		Scan(&fileID, &name, &sha, &blobID, &size, &approvalState)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, domain.ErrConflict
	}
	if err != nil {
		return result, err
	}
	if approvalState != "approved" {
		return result, domain.ErrConflict
	}
	current, err := r.cdwQMSCandidatePolicyCurrent(ctx, candidateID)
	if err != nil {
		return result, err
	}
	if !current {
		return result, domain.ErrPolicyAuthorityPending
	}
	// Serialize the file's release allocation to prevent concurrent duplicate
	// labels or duplicate use of an approved immutable candidate.
	var locked string
	if err = r.Q.QueryRow(ctx, "SELECT id FROM files WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", fileID).Scan(&locked); err != nil {
		return result, err
	}
	binding, err := r.CDWControlRole(ctx, actor, "document_control", fileID)
	if err != nil {
		return result, err
	}
	if authorityID != "" && authorityID != binding {
		return result, domain.ErrForbidden
	}
	var duplicate bool
	if err = r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_controlled_releases
 WHERE (approved_candidate_id=$1 OR (file_id=$2 AND controlled_revision=$3))
 AND state<>'cancelled')`, candidateID, fileID, label).Scan(&duplicate); err != nil {
		return result, err
	}
	if duplicate {
		return result, domain.ErrConflict
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_controlled_releases
 (id,file_id,approved_candidate_id,controlled_revision,display_name_snapshot,state,
 planned_effective_at,policy_snapshot,prepared_by,supersedes_release_id)
 VALUES($1,$2,$3,$4,$5,'preparing',$6,
 jsonb_build_object('version','cdw-g8-v1','sourceSha256',$7::text,
 'preparedRoleBindingId',$8::text,'requiresScopeApproval',true,
 'requiresDepartmentReceipt',true,'requiresReadingConfirmation',true),$9,
 (SELECT release_id FROM cdw_effective_pointers WHERE file_id=$2 AND state='active'))`,
		id, fileID, candidateID, label, name, when, sha, binding, actor)
	if err != nil {
		return result, err
	}
	// Artifact is source-only. A subsequent controlled distribution command must
	// create/verify a separate frozen distribution artifact before dispatch.
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_release_artifacts
 (id,release_id,format,purpose,blob_id,sha256,size_bytes,created_by)
 VALUES($1,$2,'docx','source',$3,$4,$5,$6)`, artifactID, id, blobID, sha, size, actor)
	if err != nil {
		return result, err
	}
	result = ports.CDWControlledRelease{ID: id, FileID: fileID, FileName: name, CandidateID: candidateID,
		RevisionLabel: label, SHA256: sha, State: "preparing", Revision: 1}
	if when != nil {
		at := when.UTC().Format(time.RFC3339Nano)
		result.PlannedEffectiveAt = &at
	}
	return result, nil
}
func (r *Repository) CDWControlEvent(ctx context.Context, actor, kind, id, key string, payload map[string]any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_domain_events
 (aggregate_kind,aggregate_id,event_kind,actor_id,request_id,details)
 VALUES('release',$1,$2,$3,$4,$5)`, id, kind, actor, key, string(raw))
	if err != nil {
		return err
	}
	hash := sha256.Sum256([]byte("release|" + actor + "|" + kind + "|" + id + "|" + key))
	_, err = r.Q.Exec(ctx, `INSERT INTO outbox_jobs(id,kind,payload)
 VALUES($1,'cdw.release.changed',$2)`, "cdw_evt_"+hex.EncodeToString(hash[:]), string(raw))
	return err
}
