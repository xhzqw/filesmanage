package application

import (
	"archive/zip"
	"bytes"
	"context"
	"strings"
	"testing"

	"filesmanage/internal/domain"
)

func makePreviewZIP(t *testing.T, contents map[string]string) []byte {
	t.Helper()
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	for name, body := range contents {
		w, err := z.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = w.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func TestContainerAdapters(t *testing.T) {
	xlsx := makePreviewZIP(t, map[string]string{
		"[Content_Types].xml":      "<Types/>",
		"xl/workbook.xml":          "<workbook/>",
		"xl/sharedStrings.xml":     "<sst><si><t>共享文本</t></si></sst>",
		"xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>`,
	})
	pptx := makePreviewZIP(t, map[string]string{
		"[Content_Types].xml": "<Types/>", "ppt/presentation.xml": "<presentation/>",
		"ppt/slides/slide1.xml": "<sld><t>产品计划</t><t>第二段</t></sld>",
	})
	docx := makePreviewZIP(t, map[string]string{
		"[Content_Types].xml": "<Types/>",
		"word/document.xml":   "<document><p><t>示例合同正文</t></p></document>",
	})
	archive := makePreviewZIP(t, map[string]string{
		"readme.txt": "hello", "files/spec.pdf": "some data",
	})
	tests := []struct {
		kind string
		data []byte
		want string
	}{
		{"spreadsheet", xlsx, "A1  共享文本"},
		{"presentation", pptx, "产品计划"},
		{"document", docx, "示例合同正文"},
		{"archive", archive, "files/spec.pdf"},
	}
	for _, tc := range tests {
		t.Run(tc.kind, func(t *testing.T) {
			res, err := containerSummary(tc.data)
			if err != nil {
				t.Fatal(err)
			}
			if res.Kind != tc.kind {
				t.Fatalf("renderer=%s, want %s", res.Kind, tc.kind)
			}
			var flattened strings.Builder
			for _, e := range res.Entries {
				flattened.WriteString(e.Name)
			}
			for _, section := range res.Sections {
				for _, line := range section.Lines {
					flattened.WriteString(line)
				}
			}
			if !strings.Contains(flattened.String(), tc.want) {
				t.Fatalf("missing %q in %+v", tc.want, res)
			}
		})
	}
}
func TestContainerPreviewRejectsSpoofAndCorruption(t *testing.T) {
	if isZIPHeader([]byte("<html>PK</html>")) {
		t.Fatal("fake zip signature accepted")
	}
	if _, err := containerSummary([]byte("PKbad")); err == nil {
		t.Fatal("invalid archive accepted")
	}
	res, err := inspectZIP(bytes.NewReader([]byte("PK")), maxContainerBytes+1, "big.xlsx")
	if err != nil || res.Kind != "spreadsheet" || !res.Truncated {
		t.Fatalf("expected bounded spreadsheet response: %+v %v", res, err)
	}
}
func TestStructuredPreviewACL(t *testing.T) {
	service, _ := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	member := domain.User{ID: "u_user", Login: "user1"}
	archive := makePreviewZIP(t, map[string]string{"inside.txt": "private"})
	uploaded, err := service.CommitUpload(ctx, admin, "folder_market", "records.zip", "application/zip", "", bytes.NewReader(archive))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Preview(ctx, member, uploaded.FileID); err != domain.ErrForbidden {
		t.Fatalf("unauthorized preview: %v", err)
	}
	share, err := service.CreateShare(ctx, admin, ShareDraft{
		ResourceKind: "file", ResourceID: uploaded.FileID, RecipientKind: "user", RecipientID: member.ID,
		Actions: []domain.Action{domain.ActionPreview},
	})
	if err != nil {
		t.Fatal(err)
	}
	preview, err := service.Preview(ctx, member, uploaded.FileID)
	if err != nil || preview.Structured == nil || preview.Renderer != "archive" {
		t.Fatalf("preview-only grant not honored: %+v %v", preview, err)
	}
	if _, _, err = service.OpenDownload(ctx, member, uploaded.FileID); err != domain.ErrForbidden {
		t.Fatalf("preview accidentally granted download: %v", err)
	}
	if err = service.RevokeShare(ctx, admin, share.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Preview(ctx, member, uploaded.FileID); err != domain.ErrForbidden {
		t.Fatalf("revoke ignored: %v", err)
	}
}
