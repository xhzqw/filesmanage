package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"

	"github.com/jackc/pgx/v5"
)

// CDWSearchEffectiveCandidates deliberately never references the ordinary
// file_text/current_version_seq. Folder visibility and CDW release-specific
// grants are both evaluated before sorting/limiting, including for admins.
// The application independently validates every returned candidate to cover
// file-level shares and any concurrently revoked access.
func (r *Repository) CDWSearchEffectiveCandidates(ctx context.Context, q ports.FileSearchQuery) ([]ports.CDWEffectiveSearchHit, error) {
	if q.Limit < 1 || q.Limit > 101 {
		return nil, domain.ErrInvalidInput
	}
	folderSQL, folderArgs, scopeCTERequired, err := r.scopeFolderSQL(ctx, q)
	if err != nil {
		return nil, err
	}
	args := []any{}
	cte := ""
	if scopeCTERequired {
		cte = scopeCTE
		args = append(args, q.UserID)
	}
	args = append(args, folderArgs...)
	ph := newPlaceholder(len(args))
	userPH := ph.next()
	args = append(args, q.UserID)
	where := []string{`f.deleted_at IS NULL`, folderSQL,
		`ptr.state='active' AND rel.state='effective' AND rel.actual_effective_at IS NOT NULL`,
		`idx.state='ready' AND idx.artifact_id=art.id AND idx.sha256=art.sha256 AND idx.blob_id=art.blob_id`,
		`art.purpose='distribution' AND art.format='docx' AND bl.state='ready'
   AND bl.sha256=art.sha256 AND bl.size_bytes=art.size_bytes`,
		`EXISTS(SELECT 1 FROM cdw_distribution_batch_items bi
    JOIN cdw_distribution_batches b ON b.id=bi.batch_id AND b.state='dispatched'
    WHERE bi.release_id=rel.id AND bi.artifact_id=art.id AND bi.artifact_sha256=art.sha256)`,
		`(EXISTS(
    SELECT 1 FROM cdw_release_access_grants g
    JOIN users u ON u.id=` + userPH + ` AND u.disabled_at IS NULL
    LEFT JOIN cdw_distribution_targets t ON t.id=g.source_target_id
    LEFT JOIN cdw_distribution_batches batch ON batch.id=t.batch_id
    WHERE g.release_id=rel.id AND g.revoked_at IS NULL
    AND (g.expires_at IS NULL OR g.expires_at>now()) AND 'preview'=ANY(g.actions)
    AND (g.user_id=u.id OR EXISTS(SELECT 1 FROM workgroup_members wm
      WHERE wm.user_id=u.id AND wm.group_id=g.group_id))
    AND (g.source_target_id IS NULL OR (t.validity_state='active'
      AND t.department_id=u.department_id AND batch.state='dispatched')))
    OR EXISTS(SELECT 1 FROM cdw_business_role_bindings rb
      JOIN users usr ON usr.id=rb.user_id AND usr.disabled_at IS NULL
      WHERE rb.user_id=` + userPH + ` AND rb.role='document_control'
      AND (rb.file_id=f.id OR rb.file_id IS NULL) AND rb.department_id IS NULL
      AND rb.revoked_at IS NULL AND rb.valid_from<=now()
      AND (rb.expires_at IS NULL OR rb.expires_at>now())))`,
	}
	snippetExpr := "' '"
	if q.Query != "" {
		patternPH := ph.next()
		textPH := ph.next()
		where = append(where, `(rel.display_name_snapshot ILIKE `+patternPH+
			` OR idx.tsv @@ phraseto_tsquery('simple',`+textPH+`))`)
		args = append(args, "%"+q.Query+"%", q.TextQuery)
		snippetPH := ph.next()
		args = append(args, q.Query)
		snippetExpr = `substring(idx.content from greatest(strpos(lower(idx.content),lower(` + snippetPH + `))-70,1) for 240)`
	}
	if q.CursorID != "" {
		timePH := ph.next()
		idPH := ph.next()
		where = append(where, `(rel.actual_effective_at,f.id)<(`+timePH+`,`+idPH+`)`)
		args = append(args, q.CursorTime, q.CursorID)
	}
	args = append(args, q.Limit)
	limitPH := ph.next()
	sql := cte + ` SELECT f.id,rel.id,rel.display_name_snapshot,art.sha256,rel.actual_effective_at,` +
		snippetExpr + ` FROM cdw_effective_pointers ptr
 JOIN cdw_controlled_releases rel ON rel.id=ptr.release_id AND rel.file_id=ptr.file_id
 JOIN files f ON f.id=ptr.file_id
 JOIN cdw_release_artifacts art ON art.release_id=rel.id
 JOIN blobs bl ON bl.id=art.blob_id
 JOIN cdw_effective_search_index idx ON idx.release_id=rel.id
 WHERE ` + strings.Join(where, " AND ") +
		` ORDER BY rel.actual_effective_at DESC,f.id DESC LIMIT ` + limitPH
	rows, err := r.Q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWEffectiveSearchHit{}
	for rows.Next() {
		var h ports.CDWEffectiveSearchHit
		if err = rows.Scan(&h.FileID, &h.ReleaseID, &h.FileName, &h.SHA256, &h.EffectiveAt, &h.Snippet); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// Each pass replenishes missing rows from the authoritative active pointer,
// then acquires exactly one bounded durable lease. On old/superseded versions,
// stored historical text is never re-authorized for search.
func (r *Repository) CDWClaimEffectiveIndexJob(ctx context.Context) (ports.CDWEffectiveSearchJob, bool, error) {
	var out ports.CDWEffectiveSearchJob
	tx, err := r.DB.Begin(ctx)
	if err != nil {
		return out, false, err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `INSERT INTO cdw_effective_search_index
 (release_id,artifact_id,blob_id,sha256,state)
 SELECT rel.id,art.id,art.blob_id,art.sha256,'pending'
 FROM cdw_effective_pointers ptr
 JOIN cdw_controlled_releases rel ON rel.id=ptr.release_id AND rel.file_id=ptr.file_id
 JOIN cdw_release_artifacts art ON art.release_id=rel.id
 JOIN cdw_distribution_batch_items bi ON bi.release_id=rel.id AND bi.artifact_id=art.id
 JOIN cdw_distribution_batches batch ON batch.id=bi.batch_id AND batch.state='dispatched'
 JOIN blobs bl ON bl.id=art.blob_id AND bl.state='ready' AND bl.sha256=art.sha256 AND bl.size_bytes=art.size_bytes
 WHERE ptr.state='active' AND rel.state='effective' AND art.purpose='distribution' AND art.format='docx'
 AND NOT EXISTS(SELECT 1 FROM cdw_effective_search_index idx WHERE idx.release_id=rel.id)
 ORDER BY rel.actual_effective_at DESC LIMIT 20 ON CONFLICT (release_id) DO NOTHING`)
	if err != nil {
		return out, false, err
	}
	err = tx.QueryRow(ctx, `SELECT idx.release_id,idx.artifact_id,idx.blob_id,idx.sha256,rel.display_name_snapshot
 FROM cdw_effective_search_index idx
 JOIN cdw_controlled_releases rel ON rel.id=idx.release_id
 JOIN cdw_effective_pointers ptr ON ptr.file_id=rel.file_id AND ptr.release_id=rel.id AND ptr.state='active'
 WHERE idx.state IN ('pending','retry') AND idx.retry_after<=clock_timestamp()
 AND (idx.lease_until IS NULL OR idx.lease_until<clock_timestamp())
 ORDER BY idx.retry_after,idx.release_id LIMIT 1 FOR UPDATE OF idx SKIP LOCKED`).
		Scan(&out.ReleaseID, &out.ArtifactID, &out.BlobID, &out.SHA256, &out.FileName)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, false, nil
	}
	if err != nil {
		return out, false, err
	}
	out.LeaseToken = domain.NewID("cdwidx")
	_, err = tx.Exec(ctx, `UPDATE cdw_effective_search_index SET
 lease_token=$2,lease_until=clock_timestamp()+interval '2 minutes',
 attempts=attempts+1,updated_at=clock_timestamp() WHERE release_id=$1`, out.ReleaseID, out.LeaseToken)
	if err != nil {
		return out, false, err
	}
	return out, true, tx.Commit(ctx)
}

func (r *Repository) CDWFinishEffectiveIndexJob(ctx context.Context, job ports.CDWEffectiveSearchJob, content, spaced string) error {
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_effective_search_index idx
 SET state='ready',content=$5,spaced=$6,lease_token=NULL,lease_until=NULL,
 updated_at=clock_timestamp()
 WHERE idx.release_id=$1 AND idx.artifact_id=$2 AND idx.blob_id=$3
 AND idx.sha256=$4 AND idx.lease_token=$7
 AND idx.lease_until>clock_timestamp()
 AND EXISTS(SELECT 1 FROM cdw_effective_pointers ptr
 JOIN cdw_controlled_releases rel ON rel.id=ptr.release_id
 JOIN blobs bl ON bl.id=idx.blob_id AND bl.state='ready' AND bl.sha256=idx.sha256
 WHERE rel.id=idx.release_id AND ptr.file_id=rel.file_id AND ptr.state='active'
 AND rel.state='effective')`, job.ReleaseID, job.ArtifactID, job.BlobID, job.SHA256, content, spaced, job.LeaseToken)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return domain.ErrVersionConflict
	}
	return nil
}
func (r *Repository) CDWRetryEffectiveIndexJob(ctx context.Context, job ports.CDWEffectiveSearchJob) error {
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_effective_search_index
 SET state='retry',lease_token=NULL,lease_until=NULL,
 retry_after=clock_timestamp()+LEAST(interval '1 hour',interval '1 minute'*power(2,LEAST(attempts,6))),
 updated_at=clock_timestamp() WHERE release_id=$1 AND lease_token=$2`, job.ReleaseID, job.LeaseToken)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return domain.ErrVersionConflict
	}
	return nil
}

var _ ports.CDWEffectiveSearchStore = (*Repository)(nil)
var _ ports.CDWEffectiveIndexJobs = (*Repository)(nil)
