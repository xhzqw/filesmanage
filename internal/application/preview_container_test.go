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
	data := makePreviewZIP(t, map[string]string{"readme.txt": "safe"})
	res, err := inspectZIP(bytes.NewReader(data), int64(len(data)), "valid.zip")
	if err != nil || res.Kind != "archive" || len(res.Entries) != 1 {
		t.Fatalf("expected archive directory response: %+v %v", res, err)
	}
}

// A ZIP larger than the previous 32 MB limit is indexed without reading
// the stored payload. It should use only central directory and EOCD bytes.
type countedZIPReader struct {
	*bytes.Reader
	readBytes int64
}

func (r *countedZIPReader) Read(p []byte) (int, error) {
	n, e := r.Reader.Read(p)
	r.readBytes += int64(n)
	return n, e
}
func TestLargeZIPCentralDirectoryWithoutPayloadRead(t *testing.T) {
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	w, err := z.CreateHeader(&zip.FileHeader{Name: "large.bin", Method: zip.Store})
	if err != nil {
		t.Fatal(err)
	}
	block := make([]byte, 1<<20)
	for i := 0; i < 35; i++ {
		if _, err = w.Write(block); err != nil {
			t.Fatal(err)
		}
	}
	if err = z.Close(); err != nil {
		t.Fatal(err)
	}
	reader := &countedZIPReader{Reader: bytes.NewReader(buf.Bytes())}
	result, err := inspectZIP(reader, int64(buf.Len()), "big.zip")
	if err != nil || len(result.Entries) != 1 || result.Entries[0].Size != 35<<20 {
		t.Fatalf("large zip not indexed: %+v %v", result, err)
	}
	if reader.readBytes > 512<<10 {
		t.Fatalf("read %d bytes, expected directory-only access", reader.readBytes)
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
