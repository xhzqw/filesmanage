package application

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"filesmanage/internal/domain"
)

func TestDOCXSummaryJoinsRunsWithinParagraph(t *testing.T) {
	xmlBody := []byte(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
	<w:p><w:r><w:t>附</w:t></w:r><w:r><w:t>件</w:t></w:r><w:r><w:t>1：</w:t></w:r></w:p>
	<w:tbl><w:tr><w:tc><w:p><w:r><w:t>联</w:t></w:r><w:r><w:t>系</w:t></w:r><w:r><w:t>人：</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
	<w:p><w:r><w:t>住所</w:t></w:r></w:p></w:body></w:document>`)
	lines, err := docxParagraphTexts(xmlBody, 180)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"附件1：", "联系人：", "住所"}; len(lines) != len(want) {
		t.Fatalf("unexpected paragraphs: %#v", lines)
	} else {
		for i, line := range lines {
			if line != want[i] {
				t.Errorf("paragraph %d: got %q, want %q", i, line, want[i])
			}
		}
	}
}

func TestNativeDOCXRoundTripEditableVersionBytes(t *testing.T) {
	original, err := editableTextDOCX("附件1：\n联系人：张三\n住所")
	if err != nil {
		t.Fatal(err)
	}
	xmlBody, err := loadNativeDocumentXML(original)
	if err != nil {
		t.Fatal(err)
	}
	parsed := extractNativeParagraphs(xmlBody)
	if len(parsed) != 3 || parsed[0].Text != "附件1：" || parsed[1].Text != "联系人：张三" {
		t.Fatalf("unexpected original paragraphs: %#v", parsed)
	}
	updated, err := rebuildNativeDOCX(original, []string{"附件1：", "联系人：李四", "住所"})
	if err != nil {
		t.Fatal(err)
	}
	newXML, err := loadNativeDocumentXML(updated)
	if err != nil {
		t.Fatal(err)
	}
	result := extractNativeParagraphs(newXML)
	if len(result) != 3 || result[1].Text != "联系人：李四" {
		t.Fatalf("DOCX save did not update paragraph: %#v", result)
	}
	if !bytes.Contains(newXML, []byte("联系人：李四")) {
		t.Fatalf("word/document.xml missing modified text")
	}
	if !bytes.Contains(newXML, []byte("附件1：")) {
		t.Fatalf("untouched paragraphs were lost")
	}
	if !strings.HasPrefix(string(newXML), "<?xml") {
		t.Fatalf("OOXML document header changed")
	}
}

func TestPDFTextToDOCXHeadingsAndTables(t *testing.T) {
	input := "# 第一章 总览\n联系人   地址   电话\n张三   北京   12345\n李四   上海   67890\n\n## 详细信息\n住所：北京市"
	raw, err := editableTextDOCX(input)
	if err != nil {
		t.Fatal(err)
	}
	xmlBody, err := loadNativeDocumentXML(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(xmlBody, []byte(`w:pStyle w:val="Heading1"`)) || !bytes.Contains(xmlBody, []byte(`w:pStyle w:val="Heading2"`)) {
		t.Fatal("headings were not marked with editable Word paragraph styles")
	}
	if !bytes.Contains(xmlBody, []byte("<w:tbl>")) || bytes.Count(xmlBody, []byte("<w:tr>")) != 3 {
		t.Fatal("column-aligned PDF text was not converted to Word table rows")
	}
	paragraphs := extractNativeParagraphs(xmlBody)
	if len(paragraphs) < 11 {
		t.Fatalf("Word table cells are not editable: %d", len(paragraphs))
	}
}

func TestConversionLineageParentAndDescendant(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	parent, err := s.CommitUpload(ctx, admin, "folder_market", "memo.docx", "application/octet-stream", "", bytes.NewReader([]byte("original")))
	if err != nil {
		t.Fatal(err)
	}
	child, err := s.commitUploadWithLineage(ctx, admin, "folder_market", "memo.pdf", "application/pdf", "", bytes.NewReader([]byte("%PDF-1.4")),
		&domain.FileLineage{SourceFileID: parent.FileID, SourceFileName: "memo.docx", SourceVersionSeq: 1, RelationType: "docx_to_pdf"})
	if err != nil {
		t.Fatal(err)
	}
	up, down, err := s.Lineage(ctx, admin, child.FileID)
	if err != nil {
		t.Fatal(err)
	}
	if up == nil || up.ID != parent.FileID || up.SourceVersionSeq != 1 || up.RelationType != "docx_to_pdf" || len(down) != 0 {
		t.Fatalf("unexpected parent and children: parent=%+v children=%+v", up, down)
	}
	_, down, err = s.Lineage(ctx, admin, parent.FileID)
	if err != nil {
		t.Fatal(err)
	}
	if len(down) != 1 || down[0].ID != child.FileID || down[0].SourceVersionSeq != 1 {
		t.Fatalf("unexpected children: %+v", down)
	}
}
