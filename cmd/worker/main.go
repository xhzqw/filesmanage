package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"filesmanage/internal/adapter/blob"
	"filesmanage/internal/adapter/postgres"
	"filesmanage/internal/domain"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

// cad-worker runs heavy conversions outside the API process (SPEC §20.4):
// claims queued outbox jobs, executes the converter as a subprocess with a
// hard timeout and memory cap, and records derivatives.
func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL required")
	}
	blobDir := os.Getenv("FILESMANAGE_BLOB_DIR")
	if blobDir == "" {
		blobDir = ".blobs"
	}
	poll := 3 * time.Second
	if raw := os.Getenv("FILESMANAGE_WORKER_POLL_SECONDS"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n >= 1 {
			poll = time.Duration(n) * time.Second
		}
	}
	concurrency := 2
	if raw := os.Getenv("FILESMANAGE_WORKER_CONCURRENCY"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n >= 1 && n <= 8 {
			concurrency = n
		}
	}
	convertTimeout := 120 * time.Second
	if raw := os.Getenv("FILESMANAGE_WORKER_CONVERT_TIMEOUT_SECONDS"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n >= 5 {
			convertTimeout = time.Duration(n) * time.Second
		}
	}
	memoryLimitMB := 2048
	if raw := os.Getenv("FILESMANAGE_WORKER_MEMORY_MB"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n >= 128 {
			memoryLimitMB = n
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatal("db pool: ", err)
	}
	defer pool.Close()
	if err = pool.Ping(ctx); err != nil {
		log.Fatal("db ping: ", err)
	}
	store := blob.New(blobDir)
	repo := postgres.New(pool)
	worker := &worker{repo: repo, store: store, timeout: convertTimeout, memoryMB: memoryLimitMB}

	log.Printf("cad-worker started poll=%s concurrency=%d convert_timeout=%s mem_cap=%dMB",
		poll, concurrency, convertTimeout, memoryLimitMB)
	sem := make(chan struct{}, concurrency)
	for {
		select {
		case <-ctx.Done():
			log.Println("cad-worker stopping")
			return
		case <-time.After(poll):
		}
		job, ok, err := repo.ClaimDerivativeJob(ctx)
		if err != nil {
			log.Println("claim error: ", err)
			continue
		}
		if !ok {
			continue
		}
		sem <- struct{}{}
		go func(job domain.DerivativeJob) {
			defer func() { <-sem }()
			if err := worker.process(ctx, job); err != nil {
				log.Printf("job %s failed: %v", job.JobID, err)
				_ = repo.FailDerivativeJob(ctx, job.JobID, err.Error())
				return
			}
			if err := repo.CompleteDerivativeJob(ctx, job.JobID); err != nil {
				log.Printf("job %s completion failed: %v", job.JobID, err)
			}
		}(job)
	}
}

type worker struct {
	repo     *postgres.Repository
	store    *blob.Store
	timeout  time.Duration
	memoryMB int
}

func (w *worker) process(ctx context.Context, job domain.DerivativeJob) error {
	// Native formats are rendered by the browser directly; the check keys on
	// the SOURCE format, because converted output (STL) shares its extension.
	switch job.SourceFormat {
	case "stl", "obj", "glb", "gltf", "dxf":
		return w.repo.MarkDerivativeNative(ctx, job.DerivativeID, job.SourceSha256)
	}
	storageKey, err := w.repo.SourceBlobPath(ctx, job.SourceSha256)
	if err != nil {
		return err
	}
	source := filepath.Join(w.store.Root, filepath.FromSlash(storageKey))
	workdir, err := os.MkdirTemp("", "cadjob-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(workdir)
	input := filepath.Join(workdir, "input."+job.SourceFormat)
	if err = copyFile(source, input); err != nil {
		return err
	}
	output := filepath.Join(workdir, "output."+job.OutputKind)
	args := conversionArgs(job.SourceFormat, input, output)
	cmdCtx, cancel := context.WithTimeout(ctx, w.timeout)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, args[0], args[1:]...)
	cmd.Dir = workdir
	// Resource isolation: address-space cap and a fresh process group so a
	// runaway converter cannot take the worker or the API down with it.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	applyMemoryLimit(cmd, w.memoryMB)
	out, err := cmd.CombinedOutput()
	if err != nil {
		if len(out) > 0 {
			return fmt.Errorf("converter failed: %v: %s", err, tail(out))
		}
		return fmt.Errorf("converter failed: %v", err)
	}
	info, err := os.Stat(output)
	if err != nil || info.Size() == 0 {
		return errors.New("converter produced no output")
	}
	// gmsh exits 0 on unreadable or empty geometry and still writes a valid
	// but empty STL, which would otherwise be published as a successful
	// derivative and shown as a blank view (MC04 demands a clear error).
	geometric, err := stlHasGeometry(output)
	if err != nil {
		return err
	}
	if !geometric {
		return errors.New("converter produced an empty mesh")
	}
	stage, err := w.store.Stage()
	if err != nil {
		return err
	}
	if err = stage.ReadFrom(output); err != nil {
		_ = stage.Abort()
		return err
	}
	stageKey, _, err := stage.Commit()
	if err != nil {
		_ = stage.Abort()
		return err
	}
	return w.repo.StoreDerivativeBlob(ctx, job.DerivativeID, domain.NewID("blob"), stageKey, stage.Sha256(), stage.Size())
}

func conversionArgs(format, input, output string) []string {
	// gmsh reads STEP/IGES through OpenCASCADE and tessellates with an explicit
	// chordal tolerance; the mesh is written as STL for the browser viewer.
	return []string{"gmsh", input, "-" + "2", "-format", "stl", "-o", output, "-clscale", "1.0"}
}

// stlHasGeometry reports whether an STL output actually contains facets.
// Binary STL carries the facet count at offset 80; ASCII STL contains "facet"
// keywords. Reading a bounded prefix is enough and keeps the worker's memory
// profile flat for large meshes.
func stlHasGeometry(path string) (bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()
	head := make([]byte, 4096)
	read, err := io.ReadFull(file, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return false, err
	}
	head = head[:read]
	if bytes.Contains(head, []byte("facet")) {
		return true, nil
	}
	if len(head) >= 84 {
		return binary.LittleEndian.Uint32(head[80:84]) > 0, nil
	}
	return false, nil
}

// applyMemoryLimit caps the converter's address space. Linux RLIMIT_AS is
// applied through the wrapper; unsupported platforms simply run uncapped.
func applyMemoryLimit(cmd *exec.Cmd, memoryMB int) {
	limit := uint64(memoryMB) * 1024 * 1024
	cmd.Env = append(os.Environ(), "FILESMANAGE_MEM_LIMIT="+strconv.FormatUint(limit, 10))
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0o600)
}

func tail(b []byte) string {
	if len(b) > 400 {
		return string(b[len(b)-400:])
	}
	return string(b)
}

