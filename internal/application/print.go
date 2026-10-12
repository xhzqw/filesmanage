package application

import (
	"context"
	"errors"
	"io"
	"strings"

	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

// BrowserPrintPreparation records a user's print intent, not a physical print.
type BrowserPrintPreparation struct {
	FileID     string `json:"fileId"`
	Name       string `json:"name"`
	VersionSeq int    `json:"versionSeq"`
	Sha256     string `json:"sha256"`
}

// Both actions must be held for the current file version. The expected digest
// fences subsequent render requests against concurrent version replacement.
func (s *Service) printSource(ctx context.Context, tx ports.Repository, u domain.User, id, expectedSHA string) (domain.File, domain.Blob, int, error) {
	file, err := s.visibleFile(ctx, tx, u, id, domain.ActionPrint)
	if err != nil {
		return domain.File{}, domain.Blob{}, 0, err
	}
	if _, err = s.visibleFile(ctx, tx, u, id, domain.ActionPreview); err != nil {
		return domain.File{}, domain.Blob{}, 0, err
	}
	seq := currentSeq(file)
	version, err := tx.VersionBySeq(ctx, file.ID, seq)
	if err != nil {
		return domain.File{}, domain.Blob{}, 0, domain.ErrNotFound
	}
	blob, err := tx.BlobByID(ctx, version.BlobID)
	if err != nil {
		return domain.File{}, domain.Blob{}, 0, domain.ErrNotFound
	}
	if expectedSHA != "" && !strings.EqualFold(blob.Sha256, expectedSHA) {
		return domain.File{}, domain.Blob{}, 0, domain.ErrConflict
	}
	return file, blob, seq, nil
}

func (s *Service) PrepareBrowserPrint(ctx context.Context, u domain.User, id, expectedSHA string) (BrowserPrintPreparation, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return BrowserPrintPreparation{}, err
	}
	defer tx.Rollback(ctx)
	file, blob, seq, err := s.printSource(ctx, tx, u, id, expectedSHA)
	if err != nil {
		return BrowserPrintPreparation{}, err
	}
	result := BrowserPrintPreparation{FileID: file.ID, Name: file.Name, VersionSeq: seq, Sha256: blob.Sha256}
	if err = auditRequired(ctx, tx, u, "file.print.prepare", "file", file.ID, "success",
		map[string]any{"versionSeq": seq, "sha256": blob.Sha256, "destination": "browser", "outcome": "dialog_requested"}); err != nil {
		return BrowserPrintPreparation{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return BrowserPrintPreparation{}, err
	}
	return result, nil
}

// Print media is limited to signature-verified passive PDF/still images.
func (s *Service) OpenBrowserPrintMedia(ctx context.Context, u domain.User, id, sha string) (Download, func(), error) {
	if len(sha) != 64 {
		return Download{}, nil, ErrInvalidInput
	}
	source, done, err := s.openBrowserPrintSource(ctx, u, id, sha)
	if err != nil {
		return Download{}, nil, err
	}
	header := make([]byte, 512)
	n, readErr := io.ReadFull(source.Reader, header)
	if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
		done()
		return Download{}, nil, readErr
	}
	kind, mime := BrowserMedia(header[:n])
	if kind != "pdf" && kind != "image" {
		done()
		return Download{}, nil, ErrPreviewUnsupported
	}
	if _, err = source.Reader.Seek(0, io.SeekStart); err != nil {
		done()
		return Download{}, nil, err
	}
	source.ContentType = mime
	return source, done, nil
}

func (s *Service) openBrowserPrintSource(ctx context.Context, u domain.User, id, sha string) (Download, func(), error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return Download{}, nil, err
	}
	defer tx.Rollback(ctx)
	file, blob, seq, err := s.printSource(ctx, tx, u, id, sha)
	if err != nil {
		return Download{}, nil, err
	}
	version, err := tx.VersionBySeq(ctx, file.ID, seq)
	if err != nil {
		return Download{}, nil, domain.ErrNotFound
	}
	reader, err := s.blobs.Open(blob.StorageKey)
	if err != nil {
		return Download{}, nil, err
	}
	if err = auditRequired(ctx, tx, u, "file.print.render", "file", file.ID, "success",
		map[string]any{"versionSeq": seq, "sha256": blob.Sha256, "destination": "browser", "outcome": "content_requested"}); err != nil {
		_ = reader.Close()
		return Download{}, nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		_ = reader.Close()
		return Download{}, nil, err
	}
	return Download{FileName: file.Name, ContentType: file.ContentType,
			Sha256: blob.Sha256, Size: blob.SizeBytes, Reader: reader, ModTime: version.CreatedAt},
		func() { _ = reader.Close() }, nil
}

func (s *Service) BrowserPrintOfficePDF(ctx context.Context, u domain.User, id, sha string) ([]byte, error) {
	return s.BrowserPrintOfficePDFSheet(ctx, u, id, sha, "")
}

func (s *Service) BrowserPrintOfficePDFSheet(ctx context.Context, u domain.User, id, sha, sheetName string) ([]byte, error) {
	if len(sha) != 64 {
		return nil, ErrInvalidInput
	}
	source, done, err := s.openBrowserPrintSource(ctx, u, id, sha)
	if err != nil {
		return nil, err
	}
	defer done()
	return renderOfficePDFSourceWithSheet(ctx, source, sheetName)
}
