package application

import (
	"archive/zip"
	"bytes"
	"testing"
)

// ONLYOFFICE is free to write the content-type ZIP entry after other parts.
// Rejecting the file because its ZIP filename falls after the first 4 KiB
// prevents an otherwise valid status=6 callback from creating a new version.
func TestOfficeSaveAcceptsContentTypesBeyondFirstFourKiB(t *testing.T) {
	var buf bytes.Buffer
	archive := zip.NewWriter(&buf)
	first, err := archive.CreateHeader(&zip.FileHeader{Name: "word/big-part.bin", Method: zip.Store})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = first.Write(bytes.Repeat([]byte{0x72}, 6000)); err != nil {
		t.Fatal(err)
	}
	second, err := archive.Create("[Content_Types].xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = second.Write([]byte(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`)); err != nil {
		t.Fatal(err)
	}
	if err = archive.Close(); err != nil {
		t.Fatal(err)
	}
	raw := buf.Bytes()
	if position := bytes.Index(raw, []byte("[Content_Types].xml")); position < 4096 {
		t.Fatalf("fixture must place content types after 4KiB, got offset %d", position)
	}
	if !looksLikeOOXML(raw) {
		t.Fatal("valid OOXML package was rejected")
	}
	if looksLikeOOXML([]byte("untrusted data")) {
		t.Fatal("non-ZIP data should be rejected")
	}
}
