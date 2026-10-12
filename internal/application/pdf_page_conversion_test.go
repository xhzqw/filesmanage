package application

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"

	"filesmanage/internal/domain"
)

func TestPDFPagePreviewDoesNotNeedDownloadOrPrint(t *testing.T) {
	if _, err := exec.LookPath("bwrap"); err != nil {
		t.Skip("Office sandbox not available")
	}
	if _, err := exec.LookPath("soffice"); err != nil {
		t.Skip("Office converter not available")
	}
	if _, err := exec.LookPath("pdftoppm"); err != nil {
		t.Skip("PDF image renderer not available")
	}
	s, _ := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	member := domain.User{ID: "u_user", Login: "user1"}
	docx := testOfficeDocumentZIP(t)
	uploaded, err := s.CommitUpload(ctx, admin, "folder_market", "preview.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "", bytes.NewReader(docx))
	if err != nil {
		t.Fatal(err)
	}
	converted, err := s.ConvertDOCXForSigning(ctx, admin, uploaded.FileID, 1, uploaded.Sha256, "long-idempotency-key-for-conversion")
	if err != nil {
		t.Fatal(err)
	}
	if converted.FileID == uploaded.FileID || !strings.HasSuffix(converted.Name, ".pdf") {
		t.Fatalf("PDF must be an independent file: %+v", converted)
	}
	source, done, err := s.OpenDownload(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatal(err)
	}
	defer done()
	if source.Sha256 != uploaded.Sha256 {
		t.Fatal("conversion changed original DOCX")
	}
	if _, err = s.PDFPreviewPages(ctx, member, converted.FileID, converted.Sha256); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("private PDF metadata leaked: %v", err)
	}
	grant, err := s.CreateShare(ctx, admin, ShareDraft{ResourceKind: "file", ResourceID: converted.FileID, RecipientKind: "user", RecipientID: member.ID, Actions: []domain.Action{domain.ActionPreview}})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.OpenDownload(ctx, member, converted.FileID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("PDF download leaked: %v", err)
	}
	count, err := s.PDFPreviewPages(ctx, member, converted.FileID, converted.Sha256)
	if err != nil || count < 1 {
		t.Fatalf("image page count %d: %v", count, err)
	}
	image, err := s.PDFPreviewPage(ctx, member, converted.FileID, converted.Sha256, 1)
	if err != nil || !bytes.HasPrefix(image, []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
		t.Fatalf("PNG page unavailable: %v", err)
	}
	// Signing-page placement uses the same rasterizer: verify it separately.
	sealPage, err := s.SealPagePNG(ctx, admin, converted.FileID, 1, 1, converted.Sha256)
	if err != nil || !bytes.HasPrefix(sealPage, []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
		t.Fatalf("signing-page image unavailable: %v", err)
	}

	if _, err = s.PDFPreviewPages(ctx, member, converted.FileID, strings.Repeat("f", 64)); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("SHA mismatch must conflict: %v", err)
	}
	if _, err = s.PDFPreviewPage(ctx, member, converted.FileID, converted.Sha256, count+1); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("bad page accepted: %v", err)
	}
	if err = s.RevokeShare(ctx, admin, grant.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.PDFPreviewPages(ctx, member, converted.FileID, converted.Sha256); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("revoked PDF page leaked: %v", err)
	}
}
func TestDOCXSigningConversionRightsAndVersion(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	member := domain.User{ID: "u_user", Login: "user1"}
	f, err := s.CommitUpload(ctx, admin, "folder_market", "original.docx", "application/octet-stream", "", bytes.NewReader(testOfficeDocumentZIP(t)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ConvertDOCXForSigning(ctx, admin, f.FileID, 2, f.Sha256, "version-fence-long-key"); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("stale version accepted: %v", err)
	}
	if _, err = s.ConvertDOCXForSigning(ctx, admin, f.FileID, 1, strings.Repeat("f", 64), "digest-fence-long-key"); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("stale SHA accepted: %v", err)
	}
	_, err = s.CreateShare(ctx, admin, ShareDraft{ResourceKind: "file", ResourceID: f.FileID, RecipientKind: "user", RecipientID: member.ID, Actions: []domain.Action{domain.ActionPreview}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ConvertDOCXForSigning(ctx, member, f.FileID, 1, f.Sha256, "preview-only-source"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("read-only share exported PDF: %v", err)
	}
}
