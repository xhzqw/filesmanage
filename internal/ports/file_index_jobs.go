package ports

import (
	"context"
	"filesmanage/internal/domain"
)

// FileIndexJobs is the persistence boundary for the asynchronous search index.
// A job is queued transactionally by the file_versions INSERT trigger.
type FileIndexJobs interface {
	IndexJobsReady(context.Context) error
	ClaimFileIndexJob(context.Context) (domain.FileIndexJob, bool, error)
	CompleteFileIndexJob(context.Context, domain.FileIndexJob) error
	RetryFileIndexJob(context.Context, domain.FileIndexJob, string) error
}
