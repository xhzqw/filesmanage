package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

func (r *Repository) CDWControlVerify(ctx context.Context, id, artifactID, evidenceID, actor string,
	expected int64, justification string) (ports.CDWControlledRelease, error) {
	var result ports.CDWControlledRelease
	var fileID, revisionLabel, name, candidateID, state, sha, sourceID, sourceBlobID string
	var rev int64
	var size int64
	err := r.Q.QueryRow(ctx, `SELECT r.file_id,r.controlled_revision,r.display_name_snapshot,
 r.approved_candidate_id,r.state,r.revision,s.sha256,
 a.id,a.blob_id,a.size_bytes FROM cdw_controlled_releases r
 JOIN cdw_release_artifacts a ON a.release_id=r.id AND a.purpose='source' AND a.format='docx'
 JOIN cdw_approved_candidates c ON c.id=r.approved_candidate_id
 JOIN cdw_approval_subjects s ON s.id=c.subject_id
 JOIN blobs bl ON bl.id=a.blob_id
 WHERE r.id=$1 AND c.content_sha256=s.sha256
 AND bl.sha256=s.sha256 AND bl.size_bytes=s.size_bytes AND bl.state='ready'
 AND a.sha256=s.sha256 AND a.size_bytes=s.size_bytes FOR UPDATE OF r`, id).
		Scan(&fileID, &revisionLabel, &name, &candidateID, &state, &rev, &sha, &sourceID, &sourceBlobID, &size)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, domain.ErrConflict
	}
	if err != nil {
		return result, err
	}
	if state != "preparing" || rev != expected {
		return result, domain.ErrVersionConflict
	}
	binding, err := r.CDWControlRole(ctx, actor, "document_control", fileID)
	if err != nil {
		return result, err
	}
	// An identity DOCX is eligible only with a separately signed justification
	// from a live document-control officer, never an implicit policy default.
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_release_artifacts
 (id,release_id,format,purpose,blob_id,sha256,size_bytes,source_blob_id,converter_version,created_by)
 VALUES($1,$2,'docx','distribution',$3,$4,$5,$3,'identity-deduplicated-v1',$6)`,
		artifactID, id, sourceBlobID, sha, size, actor)
	if err != nil {
		return result, err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_release_artifact_verifications
 (id,release_id,actor_id,role_binding_id,source_sha256,verified_artifact_id,
 requires_additional_seal,requires_conversion,justification)
 VALUES($1,$2,$3,$4,$5,$6,false,false,$7)`,
		evidenceID, id, actor, binding, sha, artifactID, justification)
	if err != nil {
		return result, err
	}
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_controlled_releases
 SET state='ready',revision=revision+1 WHERE id=$1 AND state='preparing' AND revision=$2`, id, expected)
	if err != nil {
		return result, err
	}
	if tag.RowsAffected() != 1 {
		return result, domain.ErrVersionConflict
	}
	return ports.CDWControlledRelease{ID: id, FileID: fileID, FileName: name, CandidateID: candidateID,
		RevisionLabel: revisionLabel, SHA256: sha, State: "ready", Revision: rev + 1}, nil
}
