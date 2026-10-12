package application

import (
	"context"
	"filesmanage/internal/domain"
)

// CurrentSignedPDFForDownload returns a derivative only when the active
// revision contains marks. Unsigned files retain content-addressed streaming
// and HTTP Range behavior through the existing raw download handler.
func (s *Service) CurrentSignedPDFForDownload(ctx context.Context, u domain.User, id, expectedSHA string) (*SignedPDFExport, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, id, domain.ActionDownload)
	if err != nil {
		return nil, err
	}
	if extensionOf(file.Name) != ".pdf" {
		return nil, nil
	}
	seq := currentSeq(file)
	version, err := tx.VersionBySeq(ctx, id, seq)
	if err != nil {
		return nil, domain.ErrNotFound
	}
	if version.Sha256 != expectedSHA {
		return nil, domain.ErrVersionConflict
	}
	store, err := sealRepository(tx)
	if err != nil {
		return nil, nil
	} // Legacy read-only in-memory repositories contain no signing evidence.
	latest, err := store.SealRevision(ctx, id, seq, -1)
	if err != nil {
		return nil, err
	}
	if len(latest.MarkIDs) == 0 {
		return nil, nil
	}
	if version.SizeBytes > maxSignedPDFBytes {
		return nil, ErrPreviewUnsupported
	}
	_ = tx.Rollback(ctx)
	output, err := s.ExportSignedPDFRevision(ctx, u, id, seq, latest.Revision, domain.ActionDownload)
	if err != nil {
		return nil, err
	}
	if output.SourceSha256 != expectedSHA {
		return nil, domain.ErrVersionConflict
	}
	return &output, nil
}
