package application

import (
	"context"
	"strings"

	"filesmanage/internal/domain"
)

// ConvertDOCXForSigning creates an independent, signed-ready PDF file.
// Every conversion requires source download+preview and target-folder upload;
// preview-only shares cannot be used to manufacture downloadable copies.
func (s *Service) ConvertDOCXForSigning(ctx context.Context, u domain.User, id string, expectedSeq int, expectedSHA, idempotencyKey string) (UploadResult, error) {
	if expectedSeq <= 0 || len(expectedSHA) != 64 || len(idempotencyKey) < 12 || len(idempotencyKey) > 128 {
		return UploadResult{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return UploadResult{}, err
	}
	file, err := s.visibleFile(ctx, tx, u, id, domain.ActionDownload)
	if err != nil {
		_ = tx.Rollback(ctx)
		return UploadResult{}, err
	}
	if _, err = s.visibleFile(ctx, tx, u, id, domain.ActionPreview); err != nil {
		_ = tx.Rollback(ctx)
		return UploadResult{}, err
	}
	if extensionOf(file.Name) != ".docx" {
		_ = tx.Rollback(ctx)
		return UploadResult{}, ErrPreviewUnsupported
	}
	seq := currentSeq(file)
	if seq != expectedSeq || !strings.EqualFold(file.Sha256, expectedSHA) {
		_ = tx.Rollback(ctx)
		return UploadResult{}, domain.ErrVersionConflict
	}
	folder, err := s.activeFolder(ctx, tx, file.FolderID)
	if err != nil {
		_ = tx.Rollback(ctx)
		return UploadResult{}, err
	}
	if err = s.require(ctx, tx, u, folder.ID, domain.ActionUpload); err != nil {
		_ = tx.Rollback(ctx)
		return UploadResult{}, err
	}
	name := file.Name
	folderID := file.FolderID
	_ = tx.Rollback(ctx)
	src, closeSrc, err := s.openFileBytes(ctx, u, id, domain.ActionDownload)
	if err != nil {
		return UploadResult{}, err
	}
	if !strings.EqualFold(src.Sha256, expectedSHA) || src.FileName != name {
		closeSrc()
		return UploadResult{}, domain.ErrVersionConflict
	}
	pdf, err := renderOfficePDFSource(ctx, src)
	closeSrc()
	if err != nil {
		return UploadResult{}, err
	}
	// Re-check authorization and source identity after the bounded conversion.
	check, err := s.uow.Begin(ctx)
	if err != nil {
		return UploadResult{}, err
	}
	latest, err := s.visibleFile(ctx, check, u, id, domain.ActionDownload)
	if err != nil {
		_ = check.Rollback(ctx)
		return UploadResult{}, err
	}
	if currentSeq(latest) != expectedSeq || latest.Sha256 != expectedSHA || latest.FolderID != folderID {
		_ = check.Rollback(ctx)
		return UploadResult{}, domain.ErrVersionConflict
	}
	if _, err = s.visibleFile(ctx, check, u, id, domain.ActionPreview); err != nil {
		_ = check.Rollback(ctx)
		return UploadResult{}, err
	}
	if err = s.require(ctx, check, u, folderID, domain.ActionUpload); err != nil {
		_ = check.Rollback(ctx)
		return UploadResult{}, err
	}
	_ = check.Rollback(ctx)
	base := name[:len(name)-5]
	return s.commitFriendlyConversion(ctx,u,folderID,base,"pdf",expectedSeq,"application/pdf",idempotencyKey,pdf,
		&domain.FileLineage{SourceFileID:id,SourceFileName:name,SourceVersionSeq:expectedSeq,RelationType:"seal_copy"})
}
