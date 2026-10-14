package application

import (
	"context"
	"filesmanage/internal/domain"
	"io"
)

// PreviewApprovalDraft renders only the immutable staged blob and enforces
// approval membership, download rights and preview rights on every request.
func (s *Service) PreviewApprovalDraft(ctx context.Context, actor domain.User, id string) (Preview, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return Preview{}, err
	}
	defer tx.Rollback(ctx)
	approval, file, err := s.authorizedApprovalDraft(ctx, tx, actor, id)
	if err != nil {
		return Preview{}, err
	}
	if _, err = s.visibleFile(ctx, tx, actor, file.ID, domain.ActionPreview); err != nil {
		return Preview{}, err
	}
	blob, err := tx.BlobByID(ctx, approval.PayloadBlobID)
	if err != nil {
		return Preview{}, domain.ErrNotFound
	}
	return s.previewBlob(file, blob)
}

// OpenInlineApprovalDraft streams only signature-verified passive media. It
// never serves arbitrary HTML/SVG and never bypasses the preview ACL.
func (s *Service) OpenInlineApprovalDraft(ctx context.Context, actor domain.User, id string) (Download, func(), error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return Download{}, nil, err
	}
	defer tx.Rollback(ctx)
	approval, file, err := s.authorizedApprovalDraft(ctx, tx, actor, id)
	if err != nil {
		return Download{}, nil, err
	}
	if _, err = s.visibleFile(ctx, tx, actor, file.ID, domain.ActionPreview); err != nil {
		return Download{}, nil, err
	}
	blob, err := tx.BlobByID(ctx, approval.PayloadBlobID)
	if err != nil {
		return Download{}, nil, domain.ErrNotFound
	}
	reader, err := s.blobs.Open(blob.StorageKey)
	if err != nil {
		return Download{}, nil, err
	}
	closeReader := func() { _ = reader.Close() }
	header := make([]byte, 512)
	n, readErr := io.ReadFull(reader, header)
	if readErr != nil && readErr != io.EOF && readErr != io.ErrUnexpectedEOF {
		closeReader()
		return Download{}, nil, readErr
	}
	renderer, mime := BrowserMedia(header[:n])
	if renderer == "unsupported" {
		closeReader()
		return Download{}, nil, ErrPreviewUnsupported
	}
	if _, err = reader.Seek(0, io.SeekStart); err != nil {
		closeReader()
		return Download{}, nil, err
	}
	return Download{FileName: file.Name, Sha256: blob.Sha256, Size: blob.SizeBytes, ContentType: mime, Reader: reader, ModTime: approval.CreatedAt}, closeReader, nil
}
