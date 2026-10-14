package application

import (
	"context"
	"fmt"
	"io"
	"log"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"filesmanage/internal/docx"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

// Search index maintenance (SPEC §10.1): the current signed version of every
// file is indexed on upload, save, approval commit and rollback; trashed and
// pending payloads are never indexed.

// indexTextLimit caps both the bytes read from a blob and the text stored per
// file, so indexing a huge upload cannot blow up memory or the index table.
const indexTextLimit = 1 << 20

// snippetWindow is the character window around a match in search results.
const snippetWindow = 60

// SpaceCJK inserts spaces between adjacent CJK characters so PostgreSQL's
// simple configuration tokenises them (SPEC §10.2). The index writer and the
// query planner use this same function, which is what keeps
// phraseto_tsquery('simple', …) adjacency semantics intact.
func SpaceCJK(s string) string {
	var out strings.Builder
	out.Grow(len(s) + len(s)/2)
	previousCJK := false
	for _, r := range s {
		current := isCJKRune(r)
		if current && previousCJK {
			out.WriteByte(' ')
		}
		out.WriteRune(r)
		previousCJK = current
	}
	return out.String()
}

func isCJKRune(r rune) bool {
	return unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) ||
		unicode.Is(unicode.Katakana, r) || unicode.Is(unicode.Hangul, r)
}

// ExtractText pulls indexable plain text out of file bytes (SPEC §10.1). Text
// formats decode as UTF-8; .docx goes through the bounded OOXML reader; images,
// video, PDF and CAD contribute their file name only.
func ExtractText(name, contentType string, data []byte) string {
	if len(data) == 0 {
		return ""
	}
	if strings.HasSuffix(strings.ToLower(name), ".pdf") {
		return pdfTextLayer(data)
	}
	if len(data) > indexTextLimit {
		data = data[:indexTextLimit]
	}
	lower := strings.ToLower(name)
	if strings.HasSuffix(lower, ".docx") {
		text, err := docx.DocumentText(data, indexTextLimit)
		if err != nil {
			return ""
		}
		return text
	}
	if looksTextual(name, contentType) && utf8.Valid(data) {
		return string(data) // never index lossy-decoded bytes (SPEC PT-05)
	}
	return ""
}

// WithAsyncIndexJobs enables a durable, post-commit file index queue. Legacy
// reindex tools/tests without this option retain synchronous behavior.
func (s *Service) WithAsyncIndexJobs(jobs ports.FileIndexJobs) *Service {
	s.indexJobs = jobs
	return s
}

// ReindexFile is invoked after successful version-writing commits. In the
// server, the trigger already queued the work transactionally; doing the work
// inline would add PDF parsing latency to uploads and manual saves.
func (s *Service) ReindexFile(ctx context.Context, fileID string) {
	if s.indexJobs != nil {
		return
	}
	_ = s.reindexFile(ctx, fileID)
}

// reindexFile reads only the current immutable blob. UpsertFileText also
// verifies current_version_seq under a DB row lock, preventing older jobs
// from overwriting newer search projections.
func (s *Service) reindexFile(ctx context.Context, fileID string) error {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	file, _, blob, readErr := currentVersionBlob(ctx, tx, fileID)
	_ = tx.Rollback(ctx)
	if readErr != nil {
		return readErr
	}
	reader, err := s.blobs.Open(blob.StorageKey)
	if err != nil {
		return err
	}
	defer reader.Close()
	readLimit := int64(indexTextLimit)
	if strings.HasSuffix(strings.ToLower(file.Name), ".pdf") {
		if blob.SizeBytes > maxPDFIndexSource {
			// Record an empty projection so oversized PDFs do not stay in
			// the missing-index backfill queue forever.
			return s.storeFileText(ctx, fileID, currentSeq(file), "", "")
		}
		readLimit = maxPDFIndexSource
	}
	data, err := io.ReadAll(io.LimitReader(reader, readLimit+1))
	if err != nil {
		return err
	}
	if strings.HasSuffix(strings.ToLower(file.Name), ".pdf") && int64(len(data)) > readLimit {
		return s.storeFileText(ctx, fileID, currentSeq(file), "", "")
	}
	text := ExtractText(file.Name, file.ContentType, data)
	return s.storeFileText(ctx, fileID, currentSeq(file), text, SpaceCJK(text))
}

func currentVersionBlob(ctx context.Context, repo ports.Repository, fileID string) (domain.File, domain.FileVersion, domain.Blob, error) {
	file, err := repo.FileByID(ctx, fileID)
	if err != nil {
		return domain.File{}, domain.FileVersion{}, domain.Blob{}, err
	}
	version, err := repo.VersionBySeq(ctx, file.ID, currentSeq(file))
	if err != nil {
		return domain.File{}, domain.FileVersion{}, domain.Blob{}, err
	}
	blob, err := repo.BlobByID(ctx, version.BlobID)
	if err != nil {
		return domain.File{}, domain.FileVersion{}, domain.Blob{}, err
	}
	return file, version, blob, nil
}

// storeFileText upserts the index row for the current version.
func (s *Service) storeFileText(ctx context.Context, fileID string, seq int, text, spaced string) error {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = tx.UpsertFileText(ctx, fileID, seq, text, spaced); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RunFileIndexJobs starts a fixed-size worker pool. PostgreSQL persists every
// task through restarts and arbitrates concurrent app replicas with row locks.
// Worker-owned goroutines finish before this function returns on shutdown.
func (s *Service) RunFileIndexJobs(ctx context.Context) {
	if s.indexJobs == nil {
		return
	}
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.indexWorkerLoop(ctx)
		}()
	}
	wg.Wait()
}

func (s *Service) indexWorkerLoop(ctx context.Context) {
	for ctx.Err() == nil {
		job, found, err := s.indexJobs.ClaimFileIndexJob(ctx)
		if err != nil && ctx.Err() == nil {
			log.Printf("file index claim failed: %v", err)
		}
		if err == nil && found {
			s.runIndexJob(ctx, job)
			continue
		}
		timer := time.NewTimer(2 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (s *Service) runIndexJob(ctx context.Context, job domain.FileIndexJob) {
	workCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	err := s.reindexFile(workCtx, job.FileID)
	cancel()
	// A final state update is bounded but survives the canceled work context;
	// if it cannot commit, lease expiry makes the job recoverable.
	finishCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("index job %d failed: %v", job.ID, err)
		}
		if retryErr := s.indexJobs.RetryFileIndexJob(finishCtx, job, fmt.Sprint(err)); retryErr != nil {
			log.Printf("index job %d retry state failed: %v", job.ID, retryErr)
		}
		return
	}
	if err := s.indexJobs.CompleteFileIndexJob(finishCtx, job); err != nil {
		log.Printf("index job %d completion failed: %v", job.ID, err)
	}
}

// ReindexAllFiles walks every active file and rebuilds its index row. It backs
// the one-off backfill for databases created before indexing existed, and ops
// recovery after an index corruption.
func (s *Service) ReindexAllFiles(ctx context.Context, batch int) (int, error) {
	if batch <= 0 || batch > 1000 {
		batch = 200
	}
	indexed := 0
	for {
		ids, err := s.fileIDsMissingText(ctx, batch)
		if err != nil {
			return indexed, err
		}
		if len(ids) == 0 {
			return indexed, nil
		}
		for _, id := range ids {
			if err := s.reindexFile(ctx, id); err != nil {
				return indexed, err
			}
			indexed++
		}
	}
}

func (s *Service) fileIDsMissingText(ctx context.Context, limit int) ([]string, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	return tx.FileIDsMissingText(ctx, limit)
}
