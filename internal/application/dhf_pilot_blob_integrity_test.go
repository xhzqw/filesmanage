package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"filesmanage/internal/ports"
)

// 校验真实磁盘字节；应用层测试通过端口隔离具体 Blob adapter。
type dhfIntegrityBlobPort struct{ root string }

func (p dhfIntegrityBlobPort) Stage() (ports.BlobStage, error) {
	return nil, errors.New("unused in evidence verification")
}
func (p dhfIntegrityBlobPort) Open(key string) (io.ReadSeekCloser, error) {
	return os.Open(filepath.Join(p.root, key))
}

func TestDHFPilotPhysicalEvidenceDigestAndSize(t *testing.T) {
	root := t.TempDir()
	key := "evidence.docx"
	path := filepath.Join(root, key)
	content := []byte("document content for actual DHF verification")
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(content)
	digest := hex.EncodeToString(hash[:])
	port := dhfIntegrityBlobPort{root: root}
	if err := verifyDHFPilotPhysicalBlob(context.Background(), port, key, digest, int64(len(content))); err != nil {
		t.Fatalf("valid physical evidence denied: %v", err)
	}
	changed := append([]byte{}, content...)
	changed[0] ^= 1
	if err := os.WriteFile(path, changed, 0600); err != nil {
		t.Fatal(err)
	}
	if err := verifyDHFPilotPhysicalBlob(context.Background(), port, key, digest, int64(len(content))); err == nil {
		t.Fatal("same-length disk corruption passed SHA check")
	}
	if err := verifyDHFPilotPhysicalBlob(context.Background(), port, key, digest, int64(len(content)-1)); err == nil {
		t.Fatal("different physical size passed check")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := verifyDHFPilotPhysicalBlob(context.Background(), port, key, digest, int64(len(content))); err == nil {
		t.Fatal("missing physical bytes passed check")
	}
	if err := verifyDHFPilotPhysicalBlob(context.Background(), nil, key, digest, int64(len(content))); err == nil {
		t.Fatal("missing physical store accepted")
	}
}

func TestDHFPilotPhysicalEvidenceCancellation(t *testing.T) {
	root := t.TempDir()
	key := "evidence.docx"
	content := []byte("document")
	if err := os.WriteFile(filepath.Join(root, key), content, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(content)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := verifyDHFPilotPhysicalBlob(ctx, dhfIntegrityBlobPort{root: root}, key, hex.EncodeToString(digest[:]), int64(len(content))); err == nil {
		t.Fatal("cancelled verification must fail")
	}
}
