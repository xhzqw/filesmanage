package application

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestFriendlyConversionName(t *testing.T) {
	cases := []struct {
		base, target   string
		seq, collision int
		want           string
	}{
		{"合同", "pdf", 2, 0, "合同-签署件-v2.pdf"},
		{"合同", "pdf", 2, 1, "合同-签署件-v2(1).pdf"},
		{"合同", "docx", 3, 0, "合同-转换件-v3.docx"},
		{"合同", "docx", 3, 4, "合同-转换件-v3(4).docx"},
	}
	for _, tc := range cases {
		got := friendlyConversionName(tc.base, tc.target, tc.seq, tc.collision)
		if got != tc.want {
			t.Errorf("got %q want %q", got, tc.want)
		}
	}
	long := friendlyConversionName(strings.Repeat("中", 90), "pdf", 7, 1)
	if len(long) > 195 || !utf8.ValidString(long) || !strings.HasSuffix(long, "-签署件-v7(1).pdf") {
		t.Fatalf("invalid truncated output %q bytes=%d", long, len(long))
	}
}
