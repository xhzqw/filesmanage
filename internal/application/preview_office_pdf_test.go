package application

import (
	"bytes"
	"context"
	"os/exec"
	"strings"
	"testing"

	"filesmanage/internal/domain"
)

func testOfficeDocumentZIP(t *testing.T) []byte {
	return makePreviewZIP(t, map[string]string{
		"[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		"_rels/.rels":         `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
		"word/document.xml":   `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Preview sandbox example</w:t></w:r></w:p></w:body></w:document>`,
	})
}

func TestOfficePDFPreviewACLAndSandbox(t *testing.T) {
	if _, err := exec.LookPath("bwrap"); err != nil {
		t.Skip("bwrap unavailable")
	}
	if _, err := exec.LookPath("soffice"); err != nil {
		t.Skip("soffice unavailable")
	}
	service, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	member := domain.User{ID: "u_user", Login: "user1"}
	raw := testOfficeDocumentZIP(t)
	upload, err := service.CommitUpload(context.Background(), admin, "folder_market", "sample.docx", "application/octet-stream", "", bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.OfficePDFPreview(context.Background(), member, upload.FileID); err != domain.ErrForbidden {
		t.Fatalf("unshared Office PDF leaked: %v", err)
	}
	grant, err := service.CreateShare(context.Background(), admin, ShareDraft{
		ResourceKind: "file", ResourceID: upload.FileID, RecipientKind: "user", RecipientID: member.ID,
		Actions: []domain.Action{domain.ActionPreview},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = service.OpenDownload(context.Background(), member, upload.FileID); err != domain.ErrForbidden {
		t.Fatalf("download leaked: %v", err)
	}
	pdf, err := service.OfficePDFPreview(context.Background(), member, upload.FileID)
	if err != nil {
		t.Fatalf("sandbox conversion: %v", err)
	}
	if !strings.HasPrefix(string(pdf[:min(len(pdf), 8)]), "%PDF-") {
		t.Fatalf("bad PDF header")
	}
	if err = service.RevokeShare(context.Background(), admin, grant.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = service.OfficePDFPreview(context.Background(), member, upload.FileID); err != domain.ErrForbidden {
		t.Fatalf("revoked preview leaked: %v", err)
	}
}

// Edge can be configured to download PDFs instead of displaying them. Office
// previews must therefore expose only page images, independently of download
// permission, and reject stale revisions/revoked access.
func TestOfficePageImagesPreviewOnly(t *testing.T) {
	for _, binary := range []string{"bwrap", "soffice", "pdftoppm"} {
		if _, err := exec.LookPath(binary); err != nil {
			t.Skip(binary + " unavailable")
		}
	}
	service, _ := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	member := domain.User{ID: "u_user", Login: "user1"}
	uploaded, err := service.CommitUpload(ctx, admin, "folder_market", "edge-preview.docx", "application/octet-stream", "", bytes.NewReader(testOfficeDocumentZIP(t)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.OfficePreviewPages(ctx, member, uploaded.FileID, uploaded.Sha256); err != domain.ErrForbidden {
		t.Fatalf("unshared office page count disclosed: %v", err)
	}
	grant, err := service.CreateShare(ctx, admin, ShareDraft{
		ResourceKind: "file", ResourceID: uploaded.FileID, RecipientKind: "user",
		RecipientID: member.ID, Actions: []domain.Action{domain.ActionPreview},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = service.OpenDownload(ctx, member, uploaded.FileID); err != domain.ErrForbidden {
		t.Fatalf("preview-only user can download Office source: %v", err)
	}
	count, err := service.OfficePreviewPages(ctx, member, uploaded.FileID, uploaded.Sha256)
	if err != nil || count < 1 {
		t.Fatalf("page count: %d, %v", count, err)
	}
	png, err := service.OfficePreviewPage(ctx, member, uploaded.FileID, uploaded.Sha256, 1)
	if err != nil || !bytes.HasPrefix(png, []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
		t.Fatalf("Office preview should be a PNG, never a downloadable PDF: %v", err)
	}
	if _, err = service.OfficePreviewPages(ctx, member, uploaded.FileID, strings.Repeat("f", 64)); err != domain.ErrVersionConflict {
		t.Fatalf("stale SHA accepted: %v", err)
	}
	if _, err = service.OfficePreviewPage(ctx, member, uploaded.FileID, uploaded.Sha256, count+1); err != domain.ErrInvalidInput {
		t.Fatalf("invalid page accepted: %v", err)
	}
	if err = service.RevokeShare(ctx, admin, grant.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = service.OfficePreviewPages(ctx, member, uploaded.FileID, uploaded.Sha256); err != domain.ErrForbidden {
		t.Fatalf("revoked preview was accessible: %v", err)
	}
}
