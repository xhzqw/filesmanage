package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestDWGConversionArgs(t *testing.T) {
	t.Setenv("FILESMANAGE_DWGREAD", "/opt/cad/dwgread")
	got := conversionArgs("dwg", "/tmp/input.dwg", "/tmp/output.dxf")
	want := []string{"/opt/cad/dwgread", "-O", "DXF", "-o", "/tmp/output.dxf", "/tmp/input.dwg"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("args=%q, want %q", got, want)
	}
}
func TestConvertedDXFRejectsEmptyAndTruncated(t *testing.T) {
	tmp := t.TempDir()
	cases := []struct {
		name, text string
		valid      bool
	}{
		{"valid", "0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n0\n20\n0\n11\n1\n21\n1\n0\nENDSEC\n0\nEOF\n", true},
		{"valid-text", "0\nSECTION\n2\nENTITIES\n0\nMTEXT\n1\nA\n0\nENDSEC\n0\nEOF\n", true},
		{"empty", "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n", false},
		{"header-only", "0\nSECTION\n2\nHEADER\n0\nLINE\n0\nENDSEC\n0\nEOF\n", false},
		{"truncated", "0\nSECTION\n2\nENTITIES\n0\nLINE\n0\nENDSEC\n", false},
		{"corrupt", "not dxf", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(tmp, tc.name+".dxf")
			if err := os.WriteFile(path, []byte(tc.text), 0600); err != nil {
				t.Fatal(err)
			}
			got, err := outputHasDxfGeometry(path)
			if err != nil {
				if tc.valid {
					t.Fatal(err)
				}
				return // Invalid data is correctly rejected with a parse error.
			}
			if got != tc.valid {
				t.Errorf("valid=%v want %v", got, tc.valid)
			}
		})
	}
}

// Optional remote-only fixture checks the output of a real DWG converter.
func TestConvertedDXFExternalFixture(t *testing.T) {
	path := os.Getenv("FILESMANAGE_DXF_TEST_FIXTURE")
	if path == "" {
		t.Skip("no external DWG-to-DXF fixture configured")
	}
	good, err := outputHasDxfGeometry(path)
	if err != nil {
		t.Fatal(err)
	}
	if !good {
		t.Fatalf("converted DXF is empty or malformed: %s", path)
	}
}
