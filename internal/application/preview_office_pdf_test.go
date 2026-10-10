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
