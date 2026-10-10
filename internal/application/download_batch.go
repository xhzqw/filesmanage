package application

import (
	"context"
	"filesmanage/internal/domain"
	"fmt"
	"strings"
)

const MaxZipFiles = 30
const MaxZipBytes int64 = 512 << 20

// OpenDownloadBatch preflights every item before the response starts. If any
// file is missing, forbidden or exceeds limits, not one byte is served.
// Each OpenDownload independently authorizes the current version.
func (s *Service) OpenDownloadBatch(ctx context.Context, u domain.User, ids []string) ([]Download, func(), error) {
	if len(ids) == 0 || len(ids) > MaxZipFiles {
		return nil, nil, domain.ErrInvalidInput
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if id == "" || len(id) > 128 || seen[id] {
			return nil, nil, domain.ErrInvalidInput
		}
		seen[id] = true
	}
	files := make([]Download, 0, len(ids))
	closers := make([]func(), 0, len(ids))
	cleanup := func() {
		for _, closeIt := range closers {
			closeIt()
		}
	}
	var total int64
	for _, id := range ids {
		item, closeIt, err := s.OpenDownload(ctx, u, id)
		if err != nil {
			cleanup()
			return nil, nil, err
		}
		closers = append(closers, closeIt)
		if item.Size < 0 || item.Size > MaxZipBytes-total {
			cleanup()
			return nil, nil, domain.ErrInvalidInput
		}
		total += item.Size
		files = append(files, item)
	}
	// One audit event for a prepared bundle; a failed audit closes the
	// prepared readers and prevents any response bytes from being served.
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	defer tx.Rollback(ctx)
	if err = auditRequired(ctx, tx, u, "file.download-zip", "file_batch", ids[0], "success",
		map[string]any{"count": len(ids), "originalBytes": total}); err != nil {
		cleanup()
		return nil, nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		cleanup()
		return nil, nil, err
	}
	return files, cleanup, nil
}

// UniqueZipEntryName is deterministic and strips client-controlled separators,
// traversal, control codes and Windows-colon syntax. The actual archive name
// is not used for storage or ACL decisions.
func UniqueZipEntryName(name string, index int) string {
	safe := strings.Map(func(r rune) rune {
		if r < ' ' || r == 127 || r == '/' || r == '\\' || r == ':' {
			return '_'
		}
		return r
	}, strings.TrimSpace(name))
	safe = strings.ReplaceAll(safe, "..", "__")
	safe = strings.Trim(safe, ". ")
	if safe == "" {
		safe = "file"
	}
	if len(safe) > 180 {
		safe = string([]rune(safe)[:min(len([]rune(safe)), 80)])
	}
	return fmt.Sprintf("%02d_%s", index+1, safe)
}
