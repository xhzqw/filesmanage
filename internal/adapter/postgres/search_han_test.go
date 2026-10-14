package postgres

import "testing"

func TestExactHanPairDoesNotChangeGeneralSearchSemantics(t *testing.T) {
	cases := []struct{ query, pair string }{
		{"导出", "导出"}, {"预算", "预算"}, {"文件", "文件"}, {"中文", "中文"},
		{"导", ""}, {"导出文件", ""}, {"导 出", ""}, {"导_", ""}, {"导%", ""},
		{"AB", ""}, {"ab", ""}, {"A中", ""}, {"中文a", ""}, {"a中", ""},
		{"", ""}, {"漢字", "漢字"}, {"中\n", ""}, {"１２", ""},
	}
	for _, tc := range cases {
		if got := exactHanPair(tc.query); got != tc.pair {
			t.Errorf("exactHanPair(%q) = %q, want %q", tc.query, got, tc.pair)
		}
	}
}
