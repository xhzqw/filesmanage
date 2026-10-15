package application

import (
	"bytes"
	"context"
	"errors"
	"filesmanage/internal/domain"
	"os"
	"path/filepath"
	"strings"
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

func TestInvalidDWGRejectedBeforeDerivativeQueue(t *testing.T) {
	converter := filepath.Join(t.TempDir(), "dwgread")
	if err := os.WriteFile(converter, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FILESMANAGE_DWGREAD", converter)
	s, repo := testService(t)
	ctx := context.Background()
	user := domain.User{ID: "u_admin", IsAdmin: true}
	for _, tc := range []struct {
		name string
		raw  []byte
	}{
		{"fake.dwg", []byte("AC1027xx")},
		{"spoofed.dwg", append([]byte("NOTDWG"), bytes.Repeat([]byte{0}, 128)...)},
	} {
		file, err := s.CommitUpload(ctx, user, "folder_root", tc.name, "application/octet-stream", "", bytes.NewReader(tc.raw))
		if err != nil {
			t.Fatalf("%s upload: %v", tc.name, err)
		}
		derivative, support, found, err := s.DerivativeStatus(ctx, user, file.FileID)
		if err != nil || found || support.Class != "invalid" || derivative.ID != "" {
			t.Fatalf("%s: expected invalid status, got %+v %+v found=%t err=%v", tc.name, derivative, support, found, err)
		}
		for i := 0; i < 2; i++ {
			if _, err = s.RequestDerivative(ctx, user, file.FileID); !errors.Is(err, domain.ErrInvalidInput) {
				t.Fatalf("%s request %d should reject before queue: %v", tc.name, i, err)
			}
		}
	}
	if got := len(repo.derivativeJobs); got != 0 {
		t.Fatalf("invalid DWG scheduled %d jobs", got)
	}
	if got := len(repo.derivatives); got != 0 {
		t.Fatalf("invalid DWG created %d derivatives", got)
	}
}

func TestDWGValidHeaderQueueDeduplication(t *testing.T) {
	converter := filepath.Join(t.TempDir(), "dwgread")
	if err := os.WriteFile(converter, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FILESMANAGE_DWGREAD", converter)
	s, repo := testService(t)
	user := domain.User{ID: "u_admin", IsAdmin: true}
	source := strings.NewReader("AC1027" + strings.Repeat("\x00", 128))
	file, err := s.CommitUpload(context.Background(), user, "folder_root", "drawing.dwg", "application/octet-stream", "", source)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		derivative, err := s.RequestDerivative(context.Background(), user, file.FileID)
		if err != nil || derivative.State != "queued" {
			t.Fatalf("request %d: %+v %v", i, derivative, err)
		}
	}
	if got := len(repo.derivativeJobs); got != 1 {
		t.Fatalf("repeated preview requests queued %d jobs", got)
	}
	if got := len(repo.derivatives); got != 1 {
		t.Fatalf("duplicate derivatives: %d", got)
	}
}
