package application

import (
	"bytes"
	"context"
	"filesmanage/internal/domain"
	"sync/atomic"
	"testing"
)

type fakeIndexJobStore struct {
	completed atomic.Int32
	retried   atomic.Int32
}

func (*fakeIndexJobStore) IndexJobsReady(context.Context) error { return nil }
func (*fakeIndexJobStore) ClaimFileIndexJob(context.Context) (domain.FileIndexJob, bool, error) {
	return domain.FileIndexJob{}, false, nil
}
func (s *fakeIndexJobStore) CompleteFileIndexJob(context.Context, domain.FileIndexJob) error {
	s.completed.Add(1)
	return nil
}
func (s *fakeIndexJobStore) RetryFileIndexJob(context.Context, domain.FileIndexJob, string) error {
	s.retried.Add(1)
	return nil
}

func TestAsyncIndexNeverBlocksUploadAndWorkerIndexesCommittedVersion(t *testing.T) {
	s, repo := testService(t)
	jobs := &fakeIndexJobStore{}
	s.WithAsyncIndexJobs(jobs)
	u := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	result, err := s.CommitUpload(context.Background(), u, "folder_market", "queued-index.txt",
		"text/plain", "", bytes.NewBufferString("deferred searchable contents"))
	if err != nil {
		t.Fatal(err)
	}
	repo.mu.Lock()
	_, wasIndexedInline := repo.fileText[result.FileID]
	repo.mu.Unlock()
	if wasIndexedInline {
		t.Fatal("async indexing still runs in the upload request")
	}
	s.runIndexJob(context.Background(), domain.FileIndexJob{ID: 1, FileID: result.FileID, VersionSeq: 1, LeaseOwner: "test"})
	repo.mu.Lock()
	text, wasIndexed := repo.fileText[result.FileID]
	repo.mu.Unlock()
	if !wasIndexed || text.Seq != 1 || text.Content != "deferred searchable contents" {
		t.Fatalf("committed version was not indexed: %+v", text)
	}
	if jobs.completed.Load() != 1 || jobs.retried.Load() != 0 {
		t.Fatalf("job completion status: completed=%d retried=%d", jobs.completed.Load(), jobs.retried.Load())
	}
	s.runIndexJob(context.Background(), domain.FileIndexJob{ID: 2, FileID: "missing", VersionSeq: 1})
	if jobs.retried.Load() != 1 {
		t.Fatal("failed index extraction must be retried by the durable queue")
	}
}
