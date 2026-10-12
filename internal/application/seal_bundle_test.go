package application

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func makeSealTestBundle(t *testing.T, filename string, name string, contents []byte, sha string, login string) []byte {
	t.Helper()
	manifest := map[string]any{"schemaVersion": 1, "assets": []map[string]any{{"file": filename, "name": name, "kind": "personal", "ownerLogin": login, "ownerName": "刘志文", "sha256": sha}}}
	metadata, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	writer := zip.NewWriter(&buf)
	file, err := writer.Create(filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = file.Write(contents); err != nil {
		t.Fatal(err)
	}
	m, err := writer.Create("manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.Write(metadata); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
func TestSealBulkImportValidAndTamperedZip(t *testing.T) {
	bitmap := image.NewRGBA(image.Rect(0, 0, 32, 32))
	bitmap.Set(10, 10, color.RGBA{R: 255, A: 255})
	var p bytes.Buffer
	if err := png.Encode(&p, bitmap); err != nil {
		t.Fatal(err)
	}
	sha := sha256.Sum256(p.Bytes())
	digest := hex.EncodeToString(sha[:])
	valid := makeSealTestBundle(t, "assets/01.png", "个人签名 · 刘志文", p.Bytes(), digest, "liuzhiwen")
	records, err := parseSealBundle(valid)
	if err != nil || len(records) != 1 || records[0].SHA256 != digest || records[0].OwnerLogin != "liuzhiwen" {
		t.Fatalf("valid bundle refused: %v %+v", err, records)
	}
	cases := []struct {
		label string
		data  []byte
	}{
		{"tampered_sha", makeSealTestBundle(t, "assets/01.png", "签名", p.Bytes(), "f"+digest[1:], "liuzhiwen")},
		{"malicious_path", makeSealTestBundle(t, "assets/../../a.png", "签名", p.Bytes(), digest, "liuzhiwen")},
		{"invalid_type", makeSealTestBundle(t, "assets/01.png", "签名", []byte("not png"), digest, "liuzhiwen")},
		{"missing_user", makeSealTestBundle(t, "assets/01.png", "签名", p.Bytes(), digest, "")},
		{"empty_name", makeSealTestBundle(t, "assets/01.png", "", p.Bytes(), digest, "liuzhiwen")},
	}
	for _, testCase := range cases {
		t.Run(testCase.label, func(t *testing.T) {
			if _, err := parseSealBundle(testCase.data); !errors.Is(err, domain.ErrInvalidInput) {
				t.Fatalf("invalid bundle accepted: %v", err)
			}
		})
	}
	if _, err := (&Service{}).ImportSealBundle(context.Background(), domain.User{ID: "ordinary"}, valid); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("ordinary user reached bulk import: %v", err)
	}
}
