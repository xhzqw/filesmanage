package application

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDWGSupportRequiresAvailableExecutable(t *testing.T) {
	t.Setenv("FILESMANAGE_DWGREAD", "/definitely/missing/filesmanage/dwgread")
	if got := dwgCADSupport(); got.Class != "licensed" {
		t.Fatalf("missing converter must not advertise support: %+v", got)
	}
	bin := filepath.Join(t.TempDir(), "dwgread")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FILESMANAGE_DWGREAD", bin)
	got := dwgCADSupport()
	if got.Class != "converted" || got.Format != "dwg" {
		t.Fatalf("installed converter must expose converted DWG: %+v", got)
	}
}
