package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"

	"github.com/jackc/pgx/v5"
)

func (r *Repository) CDWEffectiveRead(ctx context.Context, fileID, actorID string, action domain.Action) (ports.CDWEffectiveRead, bool, error) {
	var out ports.CDWEffectiveRead
	var state string
	var releaseID *string
	err := r.Q.QueryRow(ctx, `SELECT state,release_id FROM cdw_effective_pointers
 WHERE file_id=$1`, fileID).Scan(&state, &releaseID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, false, nil
	}
	if err != nil {
		return out, false, err
	}
	if state != "active" || releaseID == nil {
		return out, true, domain.ErrConflict
	}
	// Generic file/folder ACL permits reaching the file, but cannot grant
	// access to an effective controlled release. Recheck both individual and
	// live workgroup grants on EACH preview/download (including byte ranges).
	var granted bool
	err = r.Q.QueryRow(ctx, `SELECT EXISTS(
 SELECT 1 FROM cdw_release_access_grants g
 JOIN users u ON u.id=$2 AND u.disabled_at IS NULL
 LEFT JOIN cdw_distribution_targets t ON t.id=g.source_target_id
 LEFT JOIN cdw_distribution_batches batch ON batch.id=t.batch_id
 WHERE g.release_id=$1 AND g.revoked_at IS NULL
 AND (g.expires_at IS NULL OR g.expires_at>now())
 AND $3=ANY(g.actions)
 AND (g.user_id=$2 OR EXISTS(SELECT 1 FROM workgroup_members wm
 WHERE wm.group_id=g.group_id AND wm.user_id=$2))
 AND (g.source_target_id IS NULL OR (t.validity_state='active'
 AND t.department_id=u.department_id AND batch.state='dispatched'))
 )`, *releaseID, actorID, string(action)).Scan(&granted)
	if err != nil {
		return out, true, err
	}
	if !granted {
		if _, err = r.CDWControlRole(ctx, actorID, "document_control", fileID); err != nil {
			return out, true, domain.ErrForbidden
		}
	}
	// The first supported effective format is the exact DOCX issued in a
	// dispatched batch. Never fall through to ordinary latest on broken linkage.
	err = r.Q.QueryRow(ctx, `SELECT a.blob_id,a.sha256,rel.display_name_snapshot,
 a.format,rel.actual_effective_at
 FROM cdw_controlled_releases rel
 JOIN cdw_release_artifacts a ON a.release_id=rel.id
 JOIN cdw_distribution_batch_items bi ON bi.release_id=rel.id
 AND bi.artifact_id=a.id AND bi.artifact_sha256=a.sha256
 JOIN cdw_distribution_batches b ON b.id=bi.batch_id AND b.state='dispatched'
 JOIN blobs bl ON bl.id=a.blob_id AND bl.state='ready'
 AND bl.sha256=a.sha256 AND bl.size_bytes=a.size_bytes
 WHERE rel.id=$1 AND rel.file_id=$2 AND rel.state='effective'
 AND rel.actual_effective_at IS NOT NULL
 AND a.purpose='distribution' AND a.format='docx'
 LIMIT 1`, *releaseID, fileID).Scan(&out.BlobID, &out.SHA256,
		&out.FileName, &out.Format, &out.EffectiveAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, true, domain.ErrConflict
	}
	if err != nil {
		return out, true, err
	}
	return out, true, nil
}
