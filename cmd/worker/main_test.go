package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCopyFileStreamsAndPreservesContent(t *testing.T) {
	dir := t.TempDir()
	source, output := filepath.Join(dir, "source.step"), filepath.Join(dir, "copy.step")
	want := bytes.Repeat([]byte("cad model payload\x00"), 120000)
	if err := os.WriteFile(source, want, 0600); err != nil {
		t.Fatal(err)
	}
	if err := copyFile(context.Background(), source, output); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("stream copy changed the bytes")
	}
}

func TestCopyFileCancelledWithoutPublishingPartialDestination(t *testing.T) {
	dir := t.TempDir()
	source, output := filepath.Join(dir, "source.step"), filepath.Join(dir, "copy.step")
	if err := os.WriteFile(source, []byte("source"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := copyFile(ctx, source, output); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected canceled, got %v", err)
	}
	if _, err := os.Stat(output); !os.IsNotExist(err) {
		t.Fatalf("partial destination should be removed: %v", err)
	}
}

func TestConverterOutputHasBoundedTail(t *testing.T) {
	log := &boundedConverterOutput{}
	input := strings.Repeat("a", 20000) + "LAST"
	if n, err := log.Write([]byte(input)); err != nil || n != len(input) {
		t.Fatalf("write: %d, %v", n, err)
	}
	if len(log.String()) != 4096 || !strings.HasSuffix(log.String(), "LAST") {
		t.Fatal("log tail was not bounded")
	}
}

func TestConverterMemoryLimitIsKernelEnforced(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux RLIMIT_AS verification")
	}
	limiter, err := exec.LookPath("prlimit")
	if err != nil {
		t.Skip("prlimit not installed in this test environment")
	}
	cmd := limitedConverterCommand(context.Background(), limiter, 256,
		[]string{"/bin/sh", "-c", "ulimit -v"})
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(out)) != "262144" {
		t.Fatalf("kernel address-space cap missing: %q", out)
	}
}
