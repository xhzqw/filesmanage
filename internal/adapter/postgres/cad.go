package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
	"time"
)

// ---------- CAD derivatives ----------

const derivativeSelect = "SELECT id,file_id,version_seq,source_sha256,source_format,output_kind,coalesce(blob_id,''),coalesce(output_sha256,''),coalesce(output_size,0),converter,converter_version,settings_hash,state,coalesce(error_code,'') FROM model_derivatives"

func scanDerivative(row rowScanner) (domain.ModelDerivative, error) {
	var d domain.ModelDerivative
	err := row.Scan(&d.ID, &d.FileID, &d.VersionSeq, &d.SourceSha256, &d.SourceFormat, &d.OutputKind,
		&d.BlobID, &d.OutputSha256, &d.OutputSize, &d.Converter, &d.ConverterVersion, &d.SettingsHash, &d.State, &d.ErrorCode)
	return d, err
}

func (r *Repository) EnsureDerivative(ctx context.Context, d domain.ModelDerivative) (domain.ModelDerivative, error) {
	row := r.Q.QueryRow(ctx,
		`INSERT INTO model_derivatives(id,file_id,version_seq,source_sha256,source_format,output_kind,converter,converter_version,settings_hash,state)
		 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued')
		 ON CONFLICT (file_id,version_seq,output_kind,converter,converter_version,settings_hash)
		 DO UPDATE SET state=CASE WHEN model_derivatives.state='failed' THEN 'queued' ELSE model_derivatives.state END,
		 error_code=CASE WHEN model_derivatives.state='failed' THEN NULL ELSE model_derivatives.error_code END
		 RETURNING id,file_id,version_seq,source_sha256,source_format,output_kind,coalesce(blob_id,''),coalesce(output_sha256,''),coalesce(output_size,0),converter,converter_version,settings_hash,state,coalesce(error_code,'')`,
		d.ID, d.FileID, d.VersionSeq, d.SourceSha256, d.SourceFormat, d.OutputKind, d.Converter, d.ConverterVersion, d.SettingsHash)
	out, err := scanDerivative(row)
	if err != nil {
		return domain.ModelDerivative{}, err
	}
	return out, nil
}

func (r *Repository) EnqueueDerivativeJob(ctx context.Context, jobID, derivativeID string) error {
	_, err := r.Q.Exec(ctx,
		`INSERT INTO conversion_jobs(id,derivative_id,state)
		 SELECT $1,$2,'queued' WHERE NOT EXISTS (
		  SELECT 1 FROM conversion_jobs WHERE derivative_id=$2 AND state IN ('queued','running')
		 ) ON CONFLICT DO NOTHING`, jobID, derivativeID)
	return err
}

// ClaimDerivativeJob claims a queued or expired job. SKIP LOCKED lets multiple
// workers claim different jobs without racing on the oldest row.
func (r *Repository) ClaimDerivativeJob(ctx context.Context) (domain.DerivativeJob, bool, error) {
	var job domain.DerivativeJob
	owner := domain.NewID("lease")
	err := r.Q.QueryRow(ctx,
		`WITH candidate AS (
			SELECT id FROM conversion_jobs
			WHERE state='queued' OR (state='running' AND lease_until <= now())
			ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
		), claimed AS (
			UPDATE conversion_jobs j
			SET state='running',attempts=attempts+1,lease_owner=$1,
			    lease_until=now()+interval '90 seconds'
			FROM candidate c WHERE j.id=c.id
			RETURNING j.id,j.derivative_id
		), updated AS (
			UPDATE model_derivatives d SET state='running',started_at=now(),
			    finished_at=NULL,error_code=NULL
			WHERE d.id IN (SELECT derivative_id FROM claimed)
			RETURNING d.id,d.file_id,d.version_seq,d.source_format,d.source_sha256,d.output_kind,d.converter
		)
		SELECT c.id,u.id,u.file_id,u.version_seq,u.source_format,u.source_sha256,u.output_kind,u.converter
		FROM claimed c JOIN updated u ON u.id=c.derivative_id`, owner).
		Scan(&job.JobID, &job.DerivativeID, &job.FileID, &job.VersionSeq, &job.SourceFormat, &job.SourceSha256, &job.OutputKind, &job.Converter)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.DerivativeJob{}, false, nil
		}
		return domain.DerivativeJob{}, false, err
	}
	job.LeaseOwner = owner
	return job, true, nil
}

// RenewDerivativeJobLease returns false when the claim is no longer ours.
func (r *Repository) RenewDerivativeJobLease(ctx context.Context, jobID, owner string) (bool, error) {
	tag, err := r.Q.Exec(ctx,
		`UPDATE conversion_jobs SET lease_until=now()+interval '90 seconds'
		 WHERE id=$1 AND lease_owner=$2 AND state='running' AND lease_until>now()`, jobID, owner)
	return err == nil && tag.RowsAffected() == 1, err
}

func (r *Repository) CompleteDerivativeJobLease(ctx context.Context, jobID, owner string) error {
	tag, err := r.Q.Exec(ctx,
		`UPDATE conversion_jobs SET state='ready',lease_owner=NULL,lease_until=NULL
		 WHERE id=$1 AND lease_owner=$2 AND state='running' AND lease_until>now()`, jobID, owner)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ports.ErrRowMissing
	}
	return nil
}

func (r *Repository) FailDerivativeJobLease(ctx context.Context, jobID, owner, reason string) error {
	tx, err := r.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var derivativeID string
	err = tx.QueryRow(ctx,
		`UPDATE conversion_jobs SET state='failed',last_error=$3,
		 lease_owner=NULL,lease_until=NULL
		 WHERE id=$1 AND lease_owner=$2 AND state='running' AND lease_until>now()
		 RETURNING derivative_id`, jobID, owner, reason).Scan(&derivativeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.ErrRowMissing
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx,
		`UPDATE model_derivatives SET state='failed',error_code='CONVERT_FAILED',finished_at=now()
		 WHERE id=$1`, derivativeID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Publication must hold the same job row lock used by the claim operation.
// A stale worker must never overwrite a derivative owned by a new worker.
func (r *Repository) StoreDerivativeBlobLease(ctx context.Context, job domain.DerivativeJob, blobID, storageKey, sha string, size int64) error {
	tx, err := r.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = lockDerivativeLease(ctx, tx, job); err != nil {
		return err
	}
	bound := &Repository{DB: r.DB, Q: tx}
	if err = bound.StoreDerivativeBlob(ctx, job.DerivativeID, blobID, storageKey, sha, size); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repository) MarkDerivativeNativeLease(ctx context.Context, job domain.DerivativeJob) error {
	tx, err := r.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = lockDerivativeLease(ctx, tx, job); err != nil {
		return err
	}
	bound := &Repository{DB: r.DB, Q: tx}
	if err = bound.MarkDerivativeNative(ctx, job.DerivativeID, job.SourceSha256); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func lockDerivativeLease(ctx context.Context, tx pgx.Tx, job domain.DerivativeJob) error {
	var derivativeID string
	err := tx.QueryRow(ctx,
		`SELECT derivative_id FROM conversion_jobs
		 WHERE id=$1 AND lease_owner=$2 AND state='running' AND lease_until>now()
		 FOR UPDATE`, job.JobID, job.LeaseOwner).Scan(&derivativeID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && derivativeID != job.DerivativeID) {
		return ports.ErrRowMissing
	}
	return err
}

func (r *Repository) CompleteDerivativeJob(ctx context.Context, jobID string) error {
	_, err := r.Q.Exec(ctx,
		`UPDATE conversion_jobs SET state='ready' WHERE id=$1`, jobID)
	return err
}

func (r *Repository) FailDerivativeJob(ctx context.Context, jobID, reason string) error {
	_, err := r.Q.Exec(ctx,
		`UPDATE conversion_jobs SET state='failed',last_error=$2 WHERE id=$1`, jobID, reason)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx,
		`UPDATE model_derivatives SET state='failed',error_code='CONVERT_FAILED',finished_at=now()
		 WHERE id=(SELECT derivative_id FROM conversion_jobs WHERE id=$1)`, jobID)
	return err
}

func (r *Repository) MarkDerivativeNative(ctx context.Context, derivativeID, sourceSha string) error {
	tag, err := r.Q.Exec(ctx,
		`UPDATE model_derivatives SET state='ready',blob_id=NULL,output_sha256=$2,output_size=0,started_at=now(),finished_at=now()
		 WHERE id=$1`, derivativeID, sourceSha)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ports.ErrRowMissing
	}
	return nil
}

func (r *Repository) StoreDerivativeBlob(ctx context.Context, derivativeID, blobID, storageKey, sha string, size int64) error {
	tag, insertErr := r.Q.Exec(ctx,
		`INSERT INTO blobs(id,storage_key,sha256,size_bytes,state) VALUES($1,$2,$3,$4,'ready')
		 ON CONFLICT (storage_key) DO NOTHING`, blobID, storageKey, sha, size)
	if insertErr != nil {
		return insertErr
	}
	if tag.RowsAffected() == 0 {
		// Content-addressed store: the same converted bytes are already stored
		// (a retried conversion of the same source). Adopt the existing blob
		// row instead of referencing the id the conflict just dropped, which
		// would trip the derivative FK.
		var existingID string
		if existingErr := r.Q.QueryRow(ctx, "SELECT id FROM blobs WHERE storage_key=$1", storageKey).Scan(&existingID); existingErr != nil {
			return existingErr
		}
		blobID = existingID
	}
	updateTag, err := r.Q.Exec(ctx,
		`UPDATE model_derivatives SET state='ready',blob_id=$2,output_sha256=$3,output_size=$4,finished_at=now()
		 WHERE id=$1`, derivativeID, blobID, sha, size)
	if err != nil {
		return err
	}
	if updateTag.RowsAffected() == 0 {
		return ports.ErrRowMissing
	}
	return nil
}

func (r *Repository) DerivativeForFile(ctx context.Context, fileID string, versionSeq int) (domain.ModelDerivative, bool, error) {
	row := r.Q.QueryRow(ctx, derivativeSelect+" WHERE file_id=$1 AND version_seq=$2", fileID, versionSeq)
	d, err := scanDerivative(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ModelDerivative{}, false, nil
		}
		return domain.ModelDerivative{}, false, err
	}
	return d, true, nil
}

// SourceBlobPath resolves a source digest to its on-disk ready path.
func (r *Repository) SourceBlobPath(ctx context.Context, sha string) (string, error) {
	var storageKey string
	err := r.Q.QueryRow(ctx, "SELECT storage_key FROM blobs WHERE sha256=$1 AND state='ready' LIMIT 1", sha).Scan(&storageKey)
	if err != nil {
		return "", err
	}
	return storageKey, nil
}

var _ = time.Now
