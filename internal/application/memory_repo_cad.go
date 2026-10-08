package application

import (
	"context"
	"filesmanage/internal/domain"
)

// In-memory CAD stores for unit tests: an in-process queue is enough because
// the worker claims through the same contract.

func (r *memoryRepo) EnsureDerivative(_ context.Context, d domain.ModelDerivative) (domain.ModelDerivative, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, existing := range r.derivatives {
		if existing.FileID == d.FileID && existing.VersionSeq == d.VersionSeq && existing.OutputKind == d.OutputKind {
			return existing, nil
		}
	}
	d.State = "queued"
	r.derivatives = append(r.derivatives, d)
	return d, nil
}

func (r *memoryRepo) EnqueueDerivativeJob(_ context.Context, jobID, derivativeID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.derivativeJobs = append(r.derivativeJobs, memoryJob{id: jobID, derivativeID: derivativeID})
	return nil
}

func (r *memoryRepo) ClaimDerivativeJob(_ context.Context) (domain.DerivativeJob, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.derivativeJobs) == 0 {
		return domain.DerivativeJob{}, false, nil
	}
	job := r.derivativeJobs[0]
	r.derivativeJobs = r.derivativeJobs[1:]
	for _, d := range r.derivatives {
		if d.ID == job.derivativeID {
			return domain.DerivativeJob{
				JobID: job.id, DerivativeID: d.ID, FileID: d.FileID, VersionSeq: d.VersionSeq,
				SourceFormat: d.SourceFormat, SourceSha256: d.SourceSha256, OutputKind: d.OutputKind,
			}, true, nil
		}
	}
	return domain.DerivativeJob{}, false, nil
}

func (r *memoryRepo) CompleteDerivativeJob(context.Context, string) error { return nil }

func (r *memoryRepo) FailDerivativeJob(_ context.Context, jobID, reason string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, d := range r.derivatives {
		if d.ID == jobID {
			r.derivatives[i].State = "failed"
			r.derivatives[i].ErrorCode = "CONVERT_FAILED"
		}
	}
	return nil
}

func (r *memoryRepo) MarkDerivativeNative(_ context.Context, derivativeID, sourceSha string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, d := range r.derivatives {
		if d.ID == derivativeID {
			r.derivatives[i].State = "ready"
			r.derivatives[i].OutputSha256 = sourceSha
		}
	}
	return nil
}

func (r *memoryRepo) StoreDerivativeBlob(_ context.Context, derivativeID, blobID, storageKey, sha string, size int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, d := range r.derivatives {
		if d.ID == derivativeID {
			r.derivatives[i].State = "ready"
			r.derivatives[i].BlobID = blobID
			r.derivatives[i].OutputSha256 = sha
			r.derivatives[i].OutputSize = size
		}
	}
	return nil
}

func (r *memoryRepo) DerivativeForFile(_ context.Context, fileID string, versionSeq int) (domain.ModelDerivative, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, d := range r.derivatives {
		if d.FileID == fileID && d.VersionSeq == versionSeq {
			return d, true, nil
		}
	}
	return domain.ModelDerivative{}, false, nil
}

func (r *memoryRepo) SourceBlobPath(_ context.Context, sha string) (string, error) {
	return sha, nil
}

type memoryJob struct {
	id           string
	derivativeID string
}
