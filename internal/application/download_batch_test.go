package application

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"filesmanage/internal/domain"
	"strings"
	"testing"
)

func TestBoundedZipDownloadPreflightsAllPermissions(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	noAccess := domain.User{ID: "unrelated"}
	a, err := s.CommitUpload(ctx, admin, "folder_root", "a.txt", "text/plain", "", strings.NewReader("alpha"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.CommitUpload(ctx, admin, "folder_root", "b.txt", "text/plain", "", strings.NewReader("beta"))
	if err != nil {
		t.Fatal(err)
	}
	result, closeAll, err := s.OpenDownloadBatch(ctx, admin, []string{a.FileID, b.FileID})
	if err != nil {
		t.Fatal(err)
	}
	if len(result) != 2 || result[0].Size != 5 || result[1].Size != 4 {
		t.Fatalf("wrong ZIP inputs %+v", result)
	}
	closeAll()
	if _, _, err = s.OpenDownloadBatch(ctx, noAccess, []string{a.FileID, b.FileID}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("unauthorized ZIP %v", err)
	}
	if _, _, err = s.OpenDownloadBatch(ctx, admin, []string{a.FileID, "missing"}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("mixed missing item %v", err)
	}
	if _, _, err = s.OpenDownloadBatch(ctx, admin, []string{a.FileID, a.FileID}); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("duplicate ZIP %v", err)
	}
	if _, _, err = s.OpenDownloadBatch(ctx, admin, make([]string, 31)); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("overlimit ZIP %v", err)
	}
}
func TestZipEntryNamesAreSafe(t *testing.T) {
	for _, name := range []string{"../../etc/passwd", "..\\secrets", "", "A:\\b.txt"} {
		got := UniqueZipEntryName(name, 0)
		if strings.Contains(got, "/") || strings.Contains(got, "\\") || strings.Contains(got, ":") || strings.Contains(got, "..") {
			t.Errorf("unsafe archive entry %q -> %q", name, got)
		}
	}
}
func TestOfficePartDiffIsBoundedAndChecksumBased(t *testing.T) {
	create := func(body string) []byte {
		var buffer bytes.Buffer
		writer := zip.NewWriter(&buffer)
		file, err := writer.Create("word/document.xml")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = file.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
		if err = writer.Close(); err != nil {
			t.Fatal(err)
		}
		return buffer.Bytes()
	}
	a, ok := OfficePartLines(create("<w>first</w>"))
	if !ok || len(a) != 1 {
		t.Fatalf("missing office part %+v", a)
	}
	b, ok := OfficePartLines(create("<w>second</w>"))
	if !ok || len(b) != 1 || a[0] == b[0] {
		t.Fatalf("office component changed without diff %+v %+v", a, b)
	}
	if _, ok = OfficePartLines([]byte("not a zip")); ok {
		t.Fatal("accepted corrupt office")
	}
}
