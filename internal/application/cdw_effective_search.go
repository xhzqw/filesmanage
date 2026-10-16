package application

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"io"
	"log"
	"strings"
	"time"
	"unicode/utf8"
)

type CDWEffectiveSearchPage struct {
	Items      []ports.CDWEffectiveSearchHit `json:"items"`
	NextCursor string                        `json:"nextCursor"`
}
type controlledSearchCursor struct {
	Time time.Time `json:"time"`
	ID   string    `json:"id"`
}

func CDWEncodeEffectiveCursor(h ports.CDWEffectiveSearchHit) string {
	raw, _ := json.Marshal(controlledSearchCursor{Time: h.EffectiveAt, ID: h.FileID})
	return base64.RawURLEncoding.EncodeToString(raw)
}
func cdwDecodeEffectiveCursor(encoded string) (controlledSearchCursor, error) {
	if encoded == "" {
		return controlledSearchCursor{}, nil
	}
	if len(encoded) > 512 {
		return controlledSearchCursor{}, domain.ErrInvalidInput
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return controlledSearchCursor{}, domain.ErrInvalidInput
	}
	var cursor controlledSearchCursor
	if err = json.Unmarshal(raw, &cursor); err != nil || cursor.Time.IsZero() || cursor.ID == "" {
		return controlledSearchCursor{}, domain.ErrInvalidInput
	}
	return cursor, nil
}

// Search is intentionally uncached. A result is released only if current
// folder/file ACL AND live CDW issue preview authorization both succeed.
// PostgreSQL already applies the same filters pre-LIMIT for correct paging;
// application repeats them before materializing any filename or snippet.
func (s *Service) CDWSearchEffective(ctx context.Context, user domain.User, query, cursor string, limit int) (CDWEffectiveSearchPage, error) {
	out := CDWEffectiveSearchPage{Items: []ports.CDWEffectiveSearchHit{}}
	query = strings.TrimSpace(query)
	if !utf8.ValidString(query) || len([]rune(query)) > 120 || limit < 1 || limit > 50 {
		return out, domain.ErrInvalidInput
	}
	after, err := cdwDecodeEffectiveCursor(cursor)
	if err != nil {
		return out, err
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWEffectiveSearchStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	effective, ok := tx.(ports.CDWEffectiveReadStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	groups, err := tx.WorkgroupsOf(ctx, user.ID)
	if err != nil {
		return out, err
	}
	results, err := store.CDWSearchEffectiveCandidates(ctx, ports.FileSearchQuery{
		UserID: user.ID, GroupIDs: groups, Query: query, TextQuery: SpaceCJK(query),
		CursorTime: after.Time, CursorID: after.ID, Limit: limit + 1,
	})
	if err != nil {
		return out, err
	}
	for i, h := range results {
		if i >= limit {
			break
		}
		if _, e := s.visibleFile(ctx, tx, user, h.FileID, domain.ActionPreview); e != nil {
			if errors.Is(e, domain.ErrForbidden) || errors.Is(e, domain.ErrNotFound) {
				continue
			}
			return out, e
		}
		projection, managed, e := effective.CDWEffectiveRead(ctx, h.FileID, user.ID, domain.ActionPreview)
		if e != nil {
			if errors.Is(e, domain.ErrForbidden) || errors.Is(e, domain.ErrConflict) {
				continue
			}
			return out, e
		}
		if !managed || projection.SHA256 != h.SHA256 || projection.FileName != h.FileName ||
			!projection.EffectiveAt.Equal(h.EffectiveAt) {
			continue
		}
		h.Snippet = domain.Snippet(h.Snippet, query, 60)
		out.Items = append(out.Items, h)
	}
	if len(results) > limit {
		out.NextCursor = CDWEncodeEffectiveCursor(results[limit-1])
	}
	return out, nil
}

func (s *Service) WithCDWEffectiveIndexJobs(jobs ports.CDWEffectiveIndexJobs) *Service {
	s.cdwIndexJobs = jobs
	return s
}

// Dedicated workers index only immutable CDW blobs, never an editable head.
// The release may be superseded during extraction: the completion CAS against
// the active pointer rejects it. Failed jobs retry with durable backoff.
func (s *Service) RunCDWEffectiveIndexJobs(ctx context.Context) {
	if s.cdwIndexJobs == nil {
		return
	}
	for ctx.Err() == nil {
		claimCtx, stop := context.WithTimeout(ctx, 8*time.Second)
		job, found, err := s.cdwIndexJobs.CDWClaimEffectiveIndexJob(claimCtx)
		stop()
		if err != nil && ctx.Err() == nil {
			log.Printf("cdw search-index claim: %v", err)
		}
		if err == nil && found {
			s.runCDWEffectiveIndexJob(ctx, job)
			continue
		}
		timer := time.NewTimer(5 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
func (s *Service) runCDWEffectiveIndexJob(ctx context.Context, job ports.CDWEffectiveSearchJob) {
	workCtx, cancel := context.WithTimeout(ctx, 75*time.Second)
	err := func() error {
		tx, e := s.uow.Begin(workCtx)
		if e != nil {
			return e
		}
		blob, e := tx.BlobByID(workCtx, job.BlobID)
		_ = tx.Rollback(workCtx)
		if e != nil {
			return e
		}
		if blob.State != "ready" || blob.Sha256 != job.SHA256 {
			return domain.ErrConflict
		}
		reader, e := s.blobs.Open(blob.StorageKey)
		if e != nil {
			return e
		}
		defer reader.Close()
		// An excessively large compressed DOCX is searchable by its approved
		// filename only, rather than risking unbounded decompression/memory.
		text := ""
		if blob.SizeBytes <= 10<<20 {
			data, e := io.ReadAll(io.LimitReader(reader, (10<<20)+1))
			if e != nil {
				return e
			}
			if len(data) <= 10<<20 {
				// The artifact format is frozen as DOCX, independently of the display
				// name snapshot; a renamed title must not silently disable body indexing.
				text = ExtractText(job.FileName+".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data)
			}
		}
		return s.cdwIndexJobs.CDWFinishEffectiveIndexJob(workCtx, job, text, SpaceCJK(text))
	}()
	cancel()
	if err == nil {
		return
	}
	if ctx.Err() == nil {
		log.Printf("cdw search-index release=%s: %v", job.ReleaseID, err)
	}
	finishCtx, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	if retryErr := s.cdwIndexJobs.CDWRetryEffectiveIndexJob(finishCtx, job); retryErr != nil {
		log.Printf("cdw search-index retry failed release=%s: %v", job.ReleaseID, retryErr)
	}
}
