package application

import (
	"strings"
	"testing"
)

func TestOfficeSemanticDOCXParagraphs(t *testing.T) {
	doc := makePreviewZIP(t, map[string]string{"word/document.xml": `<document><body>
 <p><r><t>Review </t></r><r><t>contract</t></r></p>
 <p><r><t>Version 2</t></r></p></body></document>`})
	lines, ok := OfficeSemanticLines(doc, "contract.docx")
	if !ok || len(lines) != 2 || !strings.Contains(lines[0], "contract") || !strings.Contains(lines[1], "Version 2") {
		t.Fatalf("docx semantic %v %v", lines, ok)
	}
	if _, ok = OfficeSemanticLines(doc, "slide.pptx"); ok {
		t.Fatal("pptx accidentally treated as paragraphs")
	}
}
func TestOfficeSemanticXLSXCells(t *testing.T) {
	data := makePreviewZIP(t, map[string]string{
		"xl/sharedStrings.xml": `<sst><si><t>Revenue</t></si></sst>`,
		"xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1">
    <c r="A1" t="s"><v>0</v></c><c r="B1"><v>2026</v></c>
   </row></sheetData></worksheet>`,
	})
	lines, ok := OfficeSemanticLines(data, "budget.xlsx")
	if !ok || len(lines) != 2 || !strings.Contains(lines[0], "Revenue") || !strings.Contains(lines[1], "2026") {
		t.Fatalf("xlsx semantic %v %v", lines, ok)
	}
	if _, ok = OfficeSemanticLines([]byte("not zip"), "budget.xlsx"); ok {
		t.Fatal("unsafe input")
	}
}
