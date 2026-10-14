package application

import "testing"

func TestAnalyzeByteMeta(t *testing.T) {
	cases := []struct {
		name string
		data string
		want ByteMeta
	}{
		{"lf", "a\nb\n", ByteMeta{Encoding: "utf-8", EOL: "lf", EndsWithLF: true, Printable: true}},
		{"crlf", "a\r\nb\r\n", ByteMeta{Encoding: "utf-8", EOL: "crlf", EndsWithLF: true, Printable: true}},
		{"bom-lf", "\xef\xbb\xbfa\n", ByteMeta{Encoding: "utf-8-bom", HasBOM: true, EOL: "lf", EndsWithLF: true, Printable: true}},
		{"mixed", "a\r\nb\n", ByteMeta{Encoding: "utf-8", EOL: "mixed", EndsWithLF: true, Printable: true}},
		{"none", "abc", ByteMeta{Encoding: "utf-8", EOL: "none", Printable: true}},
		{"nul", "a\x00b", ByteMeta{Encoding: "utf-8", EOL: "none", Printable: false}},
	}
	for _, tc := range cases {
		meta := AnalyzeBytes([]byte(tc.data), int64(len(tc.data)), "sha")
		if meta.Encoding != tc.want.Encoding || meta.EOL != tc.want.EOL || meta.EndsWithLF != tc.want.EndsWithLF || meta.HasBOM != tc.want.HasBOM || meta.Printable != tc.want.Printable {
			t.Fatalf("%s: got %+v want %+v", tc.name, meta, tc.want)
		}
	}
}

func TestLooksTextual(t *testing.T) {
	textual := []struct{ name, ct string }{
		{"a.txt", "text/plain"}, {"a.md", "application/octet-stream"},
		{"a.json", ""}, {"a.xml", "application/xml"}, {"a.csv", ""},
	}
	for _, tc := range textual {
		if !looksTextual(tc.name, tc.ct) {
			t.Fatalf("%q/%q must be textual", tc.name, tc.ct)
		}
	}
	if looksTextual("a.bin", "application/octet-stream") {
		t.Fatal("binary must not be textual")
	}
	if looksTextual("archive.zip", "") {
		t.Fatal("zip must not be textual")
	}
}
