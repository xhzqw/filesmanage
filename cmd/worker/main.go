package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"filesmanage/internal/adapter/blob"
	"filesmanage/internal/adapter/postgres"
	"filesmanage/internal/domain"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
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
	// Never start conversions without an enforceable OS address-space limit.
	limiter, err := exec.LookPath("prlimit")
	if err != nil {
		log.Fatal("CAD worker requires Linux prlimit for converter memory isolation: ", err)
	}
	store := blob.New(blobDir)
	repo := postgres.New(pool)
	worker := &worker{repo: repo, store: store, timeout: convertTimeout, memoryMB: memoryLimitMB, limiter: limiter}

	log.Printf("cad-worker started poll=%s concurrency=%d convert_timeout=%s mem_cap=%dMB",
		poll, concurrency, convertTimeout, memoryLimitMB)
	// Persistent workers claim only when a slot is free; no already-claimed job
	// sits idle waiting on a semaphore. A finished slot claims again immediately.
	var workers sync.WaitGroup
	for i := 0; i < concurrency; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			worker.loop(ctx, poll)
		}()
	}
	<-ctx.Done()
	log.Println("cad-worker stopping; draining active jobs")
	workers.Wait()
}

type worker struct {
	repo     *postgres.Repository
	store    *blob.Store
	timeout  time.Duration
	memoryMB int
	limiter  string
}

func (w *worker) loop(ctx context.Context, poll time.Duration) {
	for ctx.Err() == nil {
		job, ok, err := w.repo.ClaimDerivativeJob(ctx)
		if err != nil && ctx.Err() == nil {
			log.Printf("claim error: %v", err)
		}
		if err == nil && ok {
			w.runJob(ctx, job)
			continue
		}
		timer := time.NewTimer(poll)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (w *worker) runJob(ctx context.Context, job domain.DerivativeJob) {
	jobCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-jobCtx.Done():
				return
			case <-ticker.C:
				checkCtx, stop := context.WithTimeout(jobCtx, 10*time.Second)
				owned, err := w.repo.RenewDerivativeJobLease(checkCtx, job.JobID, job.LeaseOwner)
				stop()
				if err != nil || !owned {
					log.Printf("job %s lost lease: %v", job.JobID, err)
					cancel()
					return
				}
			}
		}
	}()
	err := w.process(jobCtx, job)
	aborted := jobCtx.Err() != nil
	cancel()
	<-finished
	// Shutdown and lease loss are recoverable: let the lease expire instead
	// of trying to mark an incomplete conversion permanently failed.
	if ctx.Err() != nil || aborted || errors.Is(err, context.Canceled) {
		return
	}
	finishCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()
	if err != nil {
		log.Printf("job %s failed: %v", job.JobID, err)
		if updateErr := w.repo.FailDerivativeJobLease(finishCtx, job.JobID, job.LeaseOwner, err.Error()); updateErr != nil {
			log.Printf("job %s status update failed: %v", job.JobID, updateErr)
		}
		return
	}
	if err := w.repo.CompleteDerivativeJobLease(finishCtx, job.JobID, job.LeaseOwner); err != nil {
		log.Printf("job %s completion failed: %v", job.JobID, err)
	}
}

func (w *worker) process(ctx context.Context, job domain.DerivativeJob) error {
	// Native formats are rendered by the browser directly; the check keys on
	// the SOURCE format, because converted output (STL) shares its extension.
	switch job.SourceFormat {
	case "stl", "obj", "glb", "gltf", "dxf":
		return w.repo.MarkDerivativeNativeLease(ctx, job)
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
	if err = copyFile(ctx, source, input); err != nil {
		return err
	}
	output := filepath.Join(workdir, "output."+job.OutputKind)
	args := conversionArgs(job.SourceFormat, input, output)
	cmdCtx, cancel := context.WithTimeout(ctx, w.timeout)
	defer cancel()
	cmd := limitedConverterCommand(cmdCtx, w.limiter, w.memoryMB, args)
	cmd.Dir = workdir
	cmd.WaitDelay = 2 * time.Second
	// prlimit sets RLIMIT_AS before exec. An environment variable is not a
	// resource limit, and gmsh does not read FILESMANAGE_MEM_LIMIT.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		// Kill the entire converter process group on timeout/shutdown.
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return err
	}
	outputLog := &boundedConverterOutput{}
	cmd.Stdout, cmd.Stderr = outputLog, outputLog
	err = cmd.Run()
	if err != nil {
		if logTail := outputLog.String(); logTail != "" {
			return fmt.Errorf("converter failed: %w: %s", err, logTail)
		}
		return fmt.Errorf("converter failed: %w", err)
	}
	info, err := os.Stat(output)
	if err != nil || info.Size() == 0 {
		return errors.New("converter produced no output")
	}
	// Some converters exit 0 on unreadable or empty geometry and still write a valid
	// but empty mesh, which would otherwise be published as a successful
	// derivative and shown as a blank view (MC04 demands a clear error).
	var geometric bool
	if job.OutputKind == "dxf" {
		geometric, err = outputHasDxfGeometry(output)
	} else {
		geometric, err = outputHasGeometry(output)
	}
	if err != nil {
		return err
	}
	if !geometric {
		return errors.New("converter produced empty or invalid geometry")
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
	return w.repo.StoreDerivativeBlobLease(ctx, job, domain.NewID("blob"), stageKey, stage.Sha256(), stage.Size())
}

func conversionArgs(format, input, output string) []string {
	if format == "dwg" {
		bin := strings.TrimSpace(os.Getenv("FILESMANAGE_DWGREAD"))
		if bin == "" {
			bin = "dwgread"
		}
		return []string{bin, "-O", "DXF", "-o", output, input}
	}
	// gmsh reads STEP/IGES through OpenCASCADE and tessellates with an explicit
	// chordal tolerance. The mesh is written as MSH 2.2 ASCII: it keeps shared
	// node indices, so the viewer can recover the assembly's connected
	// components (parts) from the merged mesh. STL carries no such structure.
	gmshFormat := "msh2"
	if strings.EqualFold(filepath.Ext(output), ".stl") {
		gmshFormat = "stl"
	}
	return []string{"gmsh", input, "-" + "2", "-format", gmshFormat, "-o", output, "-clscale", "1.0"}
}

// outputHasGeometry reports whether a converted mesh output actually contains
// triangles. MSH 2.2 ASCII carries triangle elements (type 2) in $Elements;
// binary STL carries the facet count at offset 80 and ASCII STL contains
// "facet" keywords. Reading a bounded prefix keeps the worker's memory profile
// flat for large meshes.
func outputHasGeometry(path string) (bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()
	head := make([]byte, 65536)
	read, err := io.ReadFull(file, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return false, err
	}
	head = head[:read]
	if bytes.HasPrefix(head, []byte("$MeshFormat")) {
		return mshHasTriangles(string(head)), nil
	}
	if bytes.Contains(head, []byte("facet")) {
		return true, nil
	}
	if len(head) >= 84 {
		return binary.LittleEndian.Uint32(head[80:84]) > 0, nil
	}
	return false, nil
}

// mshHasTriangles scans an MSH 2.2 buffer for triangle elements (type 2). A
// mesh large enough to overflow the prefix is treated as geometric: an empty
// mesh is tiny, so anything that big is a real mesh.
func mshHasTriangles(text string) bool {
	start := strings.Index(text, "$Elements")
	if start < 0 {
		return len(text) >= 65536
	}
	rest := text[start:]
	if end := strings.Index(rest, "$EndElements"); end >= 0 {
		rest = rest[:end]
	}
	for _, line := range strings.Split(rest, "\n")[1:] {
		fields := strings.Fields(line)
		if len(fields) >= 4 && fields[1] == "2" {
			return true
		}
	}
	return false
}

func limitedConverterCommand(ctx context.Context, limiter string, memoryMB int, args []string) *exec.Cmd {
	limit := uint64(memoryMB) * 1024 * 1024
	argv := append([]string{"--as=" + strconv.FormatUint(limit, 10), "--"}, args...)
	return exec.CommandContext(ctx, limiter, argv...)
}

// Never materialise an entire CAD source in the Go heap.
func copyFile(ctx context.Context, src, dst string) error {
	input, err := os.Open(src)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		output.Close()
		if err != nil {
			os.Remove(dst)
		}
	}()
	buffer := make([]byte, 64<<10)
	for {
		if err = ctx.Err(); err != nil {
			return err
		}
		var n int
		n, err = input.Read(buffer)
		if n > 0 {
			if _, writeErr := output.Write(buffer[:n]); writeErr != nil {
				err = writeErr
				return err
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
	}
	if err = output.Sync(); err != nil {
		return err
	}
	err = output.Close()
	return err
}

// Limit untrusted converter stdout/stderr even when a child floods the pipe.
type boundedConverterOutput struct {
	mu  sync.Mutex
	buf []byte
}

func (w *boundedConverterOutput) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	n := len(p)
	w.buf = append(w.buf, p...)
	if len(w.buf) > 4096 {
		w.buf = append([]byte(nil), w.buf[len(w.buf)-4096:]...)
	}
	return n, nil
}

func (w *boundedConverterOutput) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return string(w.buf)
}
