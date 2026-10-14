package application

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
	"unicode"

	"filesmanage/internal/domain"
)

func TestSpaceCJKKeepsAdjacency(t *testing.T) {
	cases := map[string]string{
		"预算":     "预 算",
		"年度预算":   "年 度 预 算",
		"项目-预算": "项 目-预 算",
		"ABC测试":  "ABC测 试",
		"plain":  "plain",
		"":       "",
		"示例科技": "示 例 科 技",
	}
	for input, want := range cases {
		if got := SpaceCJK(input); got != want {
			t.Fatalf("SpaceCJK(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestExtractTextDispatchesByKind(t *testing.T) {
	text := ExtractText("notes.txt", "text/plain", []byte("年度预算 2026"))
	if text != "年度预算 2026" {
		t.Fatalf("text file must decode verbatim, got %q", text)
	}
	if got := ExtractText("image.png", "image/png", []byte("\x89PNG binary")); got != "" {
		t.Fatalf("binary formats must contribute the name only, got %q", got)
	}
	if got := ExtractText("broken.txt", "text/plain", []byte{0xff, 0xfe, 0x00}); got != "" {
		t.Fatalf("invalid UTF-8 must not be indexed as text, got %q", got)
	}
	if got := ExtractText("model.step", "application/octet-stream", []byte("ISO-10303-21;")); got != "" {
		t.Fatalf("CAD payloads must not be indexed as text, got %q", got)
	}
}

func TestExtractTextReadsDocxContainer(t *testing.T) {
	// Minimal OOXML container with one paragraph.
	document := `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>项目预算</w:t></w:r><w:r><w:t>审批流程</w:t></w:r></w:p></w:body></w:document>`
	payload := zipBytes(t, "word/document.xml", []byte(document))
	text := ExtractText("预算.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", payload)
	if !strings.Contains(text, "项目预算") || !strings.Contains(text, "审批流程") {
		t.Fatalf("docx text extraction missed content, got %q", text)
	}
	if got := ExtractText("fake.docx", "application/zip", []byte("not a zip at all")); got != "" {
		t.Fatalf("non-zip payloads must degrade to name-only indexing, got %q", got)
	}
}

func TestSnippetWindowCentresMatch(t *testing.T) {
	content := strings.Repeat("前", 200) + "年度预算" + strings.Repeat("后", 200)
	snippet := domain.Snippet(content, "预算", 60)
	if !strings.Contains(snippet, "年度预算") {
		t.Fatalf("snippet must contain the match, got %q", snippet)
	}
	// window characters on each side of the match plus the match and ellipses.
	if limit := 60*2 + len([]rune("预算")) + 2; len([]rune(snippet)) > limit {
		t.Fatalf("snippet window too wide: %d runes (limit %d)", len([]rune(snippet)), limit)
	}
	if domain.Snippet(content, "不存在的词", 60) == "" {
		t.Fatal("snippet should fall back to the content head")
	}
}

func TestIsCJKRune(t *testing.T) {
	if !isCJKRune('预') || !isCJKRune('算') {
		t.Fatal("Han characters must be recognised")
	}
	if isCJKRune('A') || isCJKRune('-') || isCJKRune(' ') {
		t.Fatal("ASCII and punctuation are not CJK")
	}
	if !unicode.Is(unicode.Hiragana, 'あ') {
		t.Fatal("kana sanity check")
	}
}

// zipBytes builds a minimal zip container holding one member.
func zipBytes(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	writer := zip.NewWriter(&buf)
	entry, err := writer.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = entry.Write(content); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
