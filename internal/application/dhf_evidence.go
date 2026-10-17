package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

// DHFOpenEvidence returns precisely the immutable file version submitted for one
// DHF deliverable. It never resolves the moving current/effective version.
// Download ACL is checked independently of project membership on every access.
func (s *Service) DHFOpenEvidence(ctx context.Context, actor domain.User, projectID string, sourceLine int) (Download, func(), error) {
	if sourceLine < 1 {
		return Download{}, nil, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return Download{}, nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.DHFStore)
	if !ok {
		return Download{}, nil, domain.ErrInvalidInput
	}
	if _, err = store.DHFProjectByID(ctx, projectID, actor.ID, false); err != nil {
		return Download{}, nil, err
	}
	item, err := store.DHFItemByLine(ctx, projectID, sourceLine)
	if err != nil {
		return Download{}, nil, err
	}
	if item.FileID == "" || item.FileVersionID == "" || item.FileSHA256 == "" {
		return Download{}, nil, domain.ErrNotFound
	}
	file, err := s.visibleFile(ctx, tx, actor, item.FileID, domain.ActionDownload)
	if err != nil {
		return Download{}, nil, err
	}
	versions, err := tx.VersionsByFile(ctx, file.ID)
	if err != nil {
		return Download{}, nil, err
	}
	var pinned domain.FileVersion
	for _, v := range versions {
		if v.ID == item.FileVersionID {
			pinned = v
			break
		}
	}
	if pinned.ID == "" || pinned.Sha256 != item.FileSHA256 {
		return Download{}, nil, domain.ErrConflict
	}
	blob, err := tx.BlobByID(ctx, pinned.BlobID)
	if err != nil {
		return Download{}, nil, err
	}
	if blob.State != "ready" || blob.Sha256 != item.FileSHA256 || blob.SizeBytes != pinned.SizeBytes {
		return Download{}, nil, domain.ErrConflict
	}
	reader, err := s.blobs.Open(blob.StorageKey)
	if err != nil {
		return Download{}, nil, err
	}
	if err = auditRequired(ctx, tx, actor, "dhf.evidence.access_prepare", "dhf_item", projectID, "success", map[string]any{"sourceLine": sourceLine, "fileId": file.ID, "versionId": pinned.ID, "sha256": pinned.Sha256}); err != nil {
		reader.Close()
		return Download{}, nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		reader.Close()
		return Download{}, nil, err
	}
	return Download{FileName: file.Name, Sha256: pinned.Sha256, Size: pinned.SizeBytes, ContentType: file.ContentType, Reader: reader, ModTime: pinned.CreatedAt}, func() { _ = reader.Close() }, nil
}
