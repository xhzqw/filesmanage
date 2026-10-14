package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

var _ ports.FileIndexJobs = (*Repository)(nil)

func (r *Repository) IndexJobsReady(ctx context.Context) error {
	_, err := r.Q.Exec(ctx, "SELECT id FROM file_index_jobs LIMIT 1")
	return err
}

// One row-lock and update per claim. Lease ownership fences stale completions,
// while ready_at provides retry backoff without busy-looping on errors.
func (r *Repository) ClaimFileIndexJob(ctx context.Context) (domain.FileIndexJob, bool, error) {
	job := domain.FileIndexJob{LeaseOwner: domain.NewID("idxlease")}
	err := r.Q.QueryRow(ctx,
		`WITH candidate AS (
			SELECT id FROM file_index_jobs
			WHERE (state='queued' AND ready_at<=now())
			   OR (state='running' AND lease_until<=now())
			ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
		)
		UPDATE file_index_jobs j
		SET state='running', attempts=attempts+1, lease_owner=$1,
		    lease_until=now()+interval '120 seconds'
		FROM candidate c WHERE j.id=c.id
		RETURNING j.id,j.file_id,j.version_seq`, job.LeaseOwner).
		Scan(&job.ID, &job.FileID, &job.VersionSeq)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.FileIndexJob{}, false, nil
	}
	return job, err == nil, err
}

func (r *Repository) CompleteFileIndexJob(ctx context.Context, job domain.FileIndexJob) error {
	tag, err := r.Q.Exec(ctx,
		`UPDATE file_index_jobs
		 SET state='done',lease_owner=NULL,lease_until=NULL,last_error=NULL
		 WHERE id=$1 AND lease_owner=$2 AND state='running' AND lease_until>now()`,
		job.ID, job.LeaseOwner)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ports.ErrRowMissing
	}
	return nil
}

func (r *Repository) RetryFileIndexJob(ctx context.Context, job domain.FileIndexJob, reason string) error {
	if len(reason) > 512 {
		reason = reason[:512]
	}
	tag, err := r.Q.Exec(ctx,
		`UPDATE file_index_jobs
		 SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
		     ready_at=now()+(attempts * interval '5 seconds'),
		     lease_owner=NULL,lease_until=NULL,last_error=$3
		 WHERE id=$1 AND lease_owner=$2 AND state='running' AND lease_until>now()`,
		job.ID, job.LeaseOwner, reason)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ports.ErrRowMissing
	}
	return nil
}
