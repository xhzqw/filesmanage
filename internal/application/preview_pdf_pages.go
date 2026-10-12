package application

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"filesmanage/internal/domain"
	"rsc.io/pdf"
)

const maxDocumentPDFPreviewBytes = 20 << 20

// PDFPreviewPages and PDFPreviewPage use preview authorization, independent
// of the print/sign privilege. The browser never embeds Chrome's PDF viewer.
func (s *Service) readAuthorizedPDF(ctx context.Context, u domain.User, id, sha string) ([]byte, int, error) {
	if len(sha) != 64 {
		return nil, 0, domain.ErrInvalidInput
	}
	source, closeSource, err := s.openFileBytes(ctx, u, id, domain.ActionPreview)
	if err != nil {
		return nil, 0, err
	}
	defer closeSource()
	if !strings.EqualFold(source.Sha256, sha) {
		return nil, 0, domain.ErrVersionConflict
	}
	if extensionOf(source.FileName) != ".pdf" || source.Size < 8 || source.Size > maxDocumentPDFPreviewBytes {
		return nil, 0, ErrPreviewUnsupported
	}
	raw, err := io.ReadAll(io.LimitReader(source.Reader, maxDocumentPDFPreviewBytes+1))
	if err != nil {
		return nil, 0, err
	}
	if int64(len(raw)) != source.Size || !bytes.HasPrefix(raw, []byte("%PDF-")) {
		return nil, 0, ErrPreviewUnsupported
	}
	doc, err := pdf.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil || doc.NumPage() < 1 || doc.NumPage() > 1000 {
		return nil, 0, ErrPreviewUnsupported
	}
	return raw, doc.NumPage(), nil
}
func (s *Service) PDFPreviewPages(ctx context.Context, u domain.User, id, sha string) (int, error) {
	_, count, err := s.readAuthorizedPDF(ctx, u, id, sha)
	return count, err
}
func (s *Service) PDFPreviewPage(ctx context.Context, u domain.User, id, sha string, page int) ([]byte, error) {
	return s.PDFPreviewPageRevision(ctx, u, id, sha, page, -1)
}
func (s *Service) PDFPreviewPageRevision(ctx context.Context, u domain.User, id, sha string, page, revision int) ([]byte, error) {
	if revision < -1 {
		return nil, domain.ErrInvalidInput
	}
	if page < 1 || page > 1000 {
		return nil, domain.ErrInvalidInput
	}
	raw, count, err := s.readAuthorizedPDF(ctx, u, id, sha)
	if err != nil {
		return nil, err
	}
	if page > count {
		return nil, domain.ErrInvalidInput
	}
	// Render exactly the same signed PDF derivative users download and print.
	// Reading the source first enforces the SHA fence for current version; a
	// concurrent source replacement is detected again after signed rendering.
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	file, readErr := s.visibleFile(ctx, tx, u, id, domain.ActionPreview)
	if readErr != nil {
		_ = tx.Rollback(ctx)
		return nil, readErr
	}
	seq := currentSeq(file)
	_ = tx.Rollback(ctx)
	export, renderErr := s.ExportSignedPDFRevision(ctx, u, id, seq, revision, domain.ActionPreview)
	if renderErr != nil {
		return nil, renderErr
	}
	if !strings.EqualFold(export.SourceSha256, sha) {
		return nil, domain.ErrVersionConflict
	}
	raw = export.Data

	select {
	case officeRenderSlots <- struct{}{}:
		defer func() { <-officeRenderSlots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	temp, err := os.CreateTemp("", "filesmanage-pdf-page-*.pdf")
	if err != nil {
		return nil, err
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	if _, err = temp.Write(raw); err != nil {
		return nil, err
	}
	if err = temp.Close(); err != nil {
		return nil, err
	}
	renderCtx, cancel := context.WithTimeout(ctx, 9*time.Second)
	defer cancel()
	cmd := exec.CommandContext(renderCtx, "pdftoppm", "-f", itoa(page), "-l", itoa(page), "-singlefile", "-scale-to", "1320", "-png", temp.Name())
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = io.Discard
	if err = cmd.Run(); err != nil {
		if errors.Is(renderCtx.Err(), context.DeadlineExceeded) {
			return nil, ErrPreviewUnsupported
		}
		return nil, ErrPreviewUnsupported
	}
	rendered := output.Bytes()
	if len(rendered) < 30 || len(rendered) > 8<<20 || !bytes.HasPrefix(rendered, []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
		return nil, ErrPreviewUnsupported
	}
	return rendered, nil
}
