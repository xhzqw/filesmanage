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
	Controlled bool   `json:"controlled"`
}

// Both actions must be held for the current user-facing version. Controlled
// versions have no ordinary file_versions.seq: seq=0 is a print-only sentinel,
// never a request to read version zero or to fall back to current_version_seq.
// Every render request rechecks the effective pointer and the supplied digest.
func (s *Service) printSource(ctx context.Context, tx ports.Repository, u domain.User, id, expectedSHA string) (domain.File, domain.Blob, int, error) {
	file, err := s.visibleFile(ctx, tx, u, id, domain.ActionPrint)
	if err != nil {
		return domain.File{}, domain.Blob{}, 0, err
	}
	if _, err = s.visibleFile(ctx, tx, u, id, domain.ActionPreview); err != nil {
		return domain.File{}, domain.Blob{}, 0, err
	}
	// An effective controlled print must be sourced from its immutable
	// distribution artifact, with live *separate* print and preview grants.
	// The exact existing DOCX->PDF renderer operates on this Blob, not a
	// second editor or an ordinary latest upload.
	if controlled, ok := tx.(ports.CDWEffectiveReadStore); ok {
		projection, managed, e := controlled.CDWEffectiveRead(ctx, file.ID, u.ID, domain.ActionPrint)
		if e != nil {
			return domain.File{}, domain.Blob{}, 0, e
		}
		if managed {
			preview, previewManaged, e := controlled.CDWEffectiveRead(ctx, file.ID, u.ID, domain.ActionPreview)
			if e != nil {
				return domain.File{}, domain.Blob{}, 0, e
			}
			if !previewManaged || preview.BlobID != projection.BlobID ||
				preview.SHA256 != projection.SHA256 || projection.Format != "docx" {
				return domain.File{}, domain.Blob{}, 0, domain.ErrConflict
			}
			blob, e := tx.BlobByID(ctx, projection.BlobID)
			if e != nil || blob.State != "ready" || blob.Sha256 != projection.SHA256 {
				return domain.File{}, domain.Blob{}, 0, domain.ErrConflict
			}
			if expectedSHA != "" && !strings.EqualFold(blob.Sha256, expectedSHA) {
				return domain.File{}, domain.Blob{}, 0, domain.ErrConflict
			}
			file.Name = projection.FileName
			file.ContentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
			file.Sha256 = blob.Sha256
			file.SizeBytes = blob.SizeBytes
			file.UpdatedAt = projection.EffectiveAt
			return file, blob, 0, nil
		}
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
	result := BrowserPrintPreparation{FileID: file.ID, Name: file.Name, VersionSeq: seq, Sha256: blob.Sha256, Controlled: seq == 0}
	if err = auditRequired(ctx, tx, u, "file.print.prepare", "file", file.ID, "success",
		map[string]any{"versionSeq": seq, "controlled": seq == 0, "sha256": blob.Sha256, "destination": "browser", "outcome": "dialog_requested"}); err != nil {
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
	modTime := file.UpdatedAt
	if seq != 0 {
		version, versionErr := tx.VersionBySeq(ctx, file.ID, seq)
		if versionErr != nil {
			return Download{}, nil, domain.ErrNotFound
		}
		modTime = version.CreatedAt
	}
	reader, err := s.blobs.Open(blob.StorageKey)
	if err != nil {
		return Download{}, nil, err
	}
	if err = auditRequired(ctx, tx, u, "file.print.render", "file", file.ID, "success",
		map[string]any{"versionSeq": seq, "controlled": seq == 0, "sha256": blob.Sha256, "destination": "browser", "outcome": "content_requested"}); err != nil {
		_ = reader.Close()
		return Download{}, nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		_ = reader.Close()
		return Download{}, nil, err
	}
	return Download{FileName: file.Name, ContentType: file.ContentType,
			Sha256: blob.Sha256, Size: blob.SizeBytes, Reader: reader, ModTime: modTime},
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
	key := source.Sha256 + "|" + extensionOf(source.FileName) + "|" + sheetName
	return s.cachedOfficePDF(ctx, key, func(workCtx context.Context) ([]byte, error) {
		fresh, finish, err := s.openBrowserPrintSource(workCtx, u, id, sha)
		if err != nil {
			return nil, err
		}
		defer finish()
		return renderOfficePDFSourceWithSheet(workCtx, fresh, sheetName)
	})
}
