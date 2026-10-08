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
		 DO UPDATE SET state='queued'
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
		"INSERT INTO conversion_jobs(id,derivative_id,state) VALUES($1,$2,'queued') ON CONFLICT DO NOTHING", jobID, derivativeID)
	return err
}

// ClaimDerivativeJob atomically takes the oldest queued job and marks its
// derivative running; the state predicate is the concurrency gate.
func (r *Repository) ClaimDerivativeJob(ctx context.Context) (domain.DerivativeJob, bool, error) {
	var job domain.DerivativeJob
	err := r.Q.QueryRow(ctx,
		`WITH claimed AS (
			UPDATE conversion_jobs SET state='running',attempts=attempts+1
			WHERE id=(SELECT id FROM conversion_jobs WHERE state='queued' ORDER BY created_at LIMIT 1)
			RETURNING id,derivative_id
		), updated AS (
			UPDATE model_derivatives d SET state='running',started_at=now()
			WHERE d.id IN (SELECT derivative_id FROM claimed)
			RETURNING d.id,d.file_id,d.version_seq,d.source_format,d.source_sha256,d.output_kind,d.converter
		)
		SELECT c.id,u.id,u.file_id,u.version_seq,u.source_format,u.source_sha256,u.output_kind,u.converter
		FROM claimed c JOIN updated u ON u.id=c.derivative_id`).
		Scan(&job.JobID, &job.DerivativeID, &job.FileID, &job.VersionSeq, &job.SourceFormat, &job.SourceSha256, &job.OutputKind, &job.Converter)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.DerivativeJob{}, false, nil
		}
		return domain.DerivativeJob{}, false, err
	}
	return job, true, nil
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
