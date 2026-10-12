package application

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"filesmanage/internal/domain"
)

const maxOfficeSourceBytes = 12 << 20
const maxOfficePDFBytes = 32 << 20

var officeRenderSlots = make(chan struct{}, 2)

// The derivative cache is process-local and bounded: an authorized request
// always checks ACLs before a cached PDF is returned. Content-addressed keys
// prevent a saved new version from observing its predecessor's derivative.
const officeCacheMaxBytes = 64 << 20
const officeCacheMaxEntries = 8
const officeCacheTTL = 5 * time.Minute

type officePDFEntry struct {
	pdf     []byte
	expires time.Time
}

type officePDFCache struct {
	mu      sync.Mutex
	entries map[string]officePDFEntry
	used    int
}

func (c *officePDFCache) get(key string, now time.Time) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, found := c.entries[key]
	if !found {
		return nil, false
	}
	if !now.Before(entry.expires) {
		delete(c.entries, key)
		c.used -= len(entry.pdf)
		return nil, false
	}
	return entry.pdf, true
}

func (c *officePDFCache) put(key string, pdf []byte, now time.Time) {
	if len(pdf) == 0 || len(pdf) > maxOfficePDFBytes {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]officePDFEntry)
	}
	if previous, ok := c.entries[key]; ok {
		c.used -= len(previous.pdf)
		delete(c.entries, key)
	}
	for name, entry := range c.entries {
		if !now.Before(entry.expires) {
			delete(c.entries, name)
			c.used -= len(entry.pdf)
		}
	}
	for len(c.entries) >= officeCacheMaxEntries || c.used+len(pdf) > officeCacheMaxBytes {
		var oldestKey string
		var oldest time.Time
		for name, entry := range c.entries {
			if oldestKey == "" || entry.expires.Before(oldest) {
				oldest, oldestKey = entry.expires, name
			}
		}
		if oldestKey == "" {
			return
		}
		c.used -= len(c.entries[oldestKey].pdf)
		delete(c.entries, oldestKey)
	}
	c.entries[key] = officePDFEntry{pdf: pdf, expires: now.Add(officeCacheTTL)}
	c.used += len(pdf)
}

// Work lives independently of the first HTTP caller: its renderer owns fresh
// blob handles. Individual waiters still honor their own cancellation.
func (s *Service) cachedOfficePDF(ctx context.Context, key string, render func(context.Context) ([]byte, error)) ([]byte, error) {
	if cached, ok := s.officeCache.get(key, s.now()); ok {
		return cached, nil
	}
	results := s.officeFlights.DoChan(key, func() (any, error) {
		if cached, ok := s.officeCache.get(key, s.now()); ok {
			return cached, nil
		}
		workCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		pdf, err := render(workCtx)
		if err != nil {
			return nil, err
		}
		s.officeCache.put(key, pdf, s.now())
		return pdf, nil
	})
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case result := <-results:
		if result.Err != nil {
			return nil, result.Err
		}
		return result.Val.([]byte), nil
	}
}

// OfficePDFPreview is a best-effort, read-only derivative from the immutable
// current blob. It uses ActionPreview (not ActionDownload) and never publishes
// a file version. Conversion never runs with host network or writable mounts.
func (s *Service) OfficePDFPreview(ctx context.Context, u domain.User, fileID string) ([]byte, error) {
	source, done, err := s.openFileBytes(ctx, u, fileID, domain.ActionPreview)
	if err != nil {
		return nil, err
	}
	defer done()
	key := source.Sha256 + "|" + extensionOf(source.FileName) + "|"
	return s.cachedOfficePDF(ctx, key, func(workCtx context.Context) ([]byte, error) {
		// Do not capture the original request's reader: it is closed if its
		// caller disconnects while another subscriber still needs the PDF.
		fresh, finish, err := s.openFileBytes(workCtx, u, fileID, domain.ActionPreview)
		if err != nil {
			return nil, err
		}
		defer finish()
		if fresh.Sha256 != source.Sha256 {
			return nil, domain.ErrVersionConflict
		}
		return renderOfficePDFSource(workCtx, fresh)
	})
}

func renderOfficePDFSource(ctx context.Context, source Download) ([]byte, error) {
	return renderOfficePDFSourceWithSheet(ctx, source, "")
}

func renderOfficePDFSourceWithSheet(ctx context.Context, source Download, sheetName string) ([]byte, error) {
	var format string
	switch extensionOf(source.FileName) {
	case ".docx":
		format = "document"
	case ".xlsx":
		format = "spreadsheet"
	case ".pptx":
		format = "presentation"
	default:
		return nil, ErrPreviewUnsupported
	}
	if source.Size <= 0 || source.Size > maxOfficeSourceBytes {
		return nil, fmt.Errorf("office preview source exceeds limit")
	}
	raw, err := io.ReadAll(io.LimitReader(source.Reader, maxOfficeSourceBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxOfficeSourceBytes || !isZIPHeader(raw) {
		return nil, ErrPreviewUnsupported
	}
	index, err := containerSummary(raw)
	if err != nil || index.Kind != format {
		return nil, ErrPreviewUnsupported
	}
	if sheetName != "" {
		if format != "spreadsheet" {
			return nil, ErrInvalidInput
		}
		raw, err = selectWorkbookSheet(raw, sheetName)
		if err != nil {
			return nil, err
		}
	}
	// Only known OOXML packages are allowed. Total expanded size limits ZIP
	// bombs without opening arbitrary members; the preview adapter separately
	// limits all XML decompression for the textual fallback.
	zr, err := zipPackageIndex(raw)
	if err != nil {
		return nil, ErrPreviewUnsupported
	}
	var expanded uint64
	for _, entry := range zr.File {
		if entry.Flags&1 != 0 || entry.UncompressedSize64 > 96<<20-expanded {
			return nil, ErrPreviewUnsupported
		}
		expanded += entry.UncompressedSize64
	}
	select {
	case officeRenderSlots <- struct{}{}:
		defer func() { <-officeRenderSlots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return renderOfficeSandbox(ctx, raw, extensionOf(source.FileName))
}

func zipPackageIndex(data []byte) (*zip.Reader, error) {
	if _, limited, err := zipIndexBounds(bytes.NewReader(data), int64(len(data))); err != nil || limited {
		return nil, ErrPreviewUnsupported
	}
	return zip.NewReader(bytes.NewReader(data), int64(len(data)))
}

func renderOfficeSandbox(ctx context.Context, source []byte, ext string) ([]byte, error) {
	work, err := os.MkdirTemp("", "filesmanage-render-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(work)
	if err = os.Mkdir(filepath.Join(work, "out"), 0700); err != nil {
		return nil, err
	}
	if err = os.WriteFile(filepath.Join(work, "source"+ext), source, 0600); err != nil {
		return nil, err
	}
	convertCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	// A dedicated PID, mount, IPC, UTS, network and user namespace; the only
	// writable persistent host path is the disposable work dir.
	args := []string{
		"--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
		"--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin",
		"--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
		"--dir", "/etc", "--ro-bind", "/etc/libreoffice", "/etc/libreoffice",
		"--ro-bind", "/etc/fonts", "/etc/fonts",
		"--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
		"--bind", work, "/work", "--chdir", "/work",
		"--setenv", "HOME", "/work", "--setenv", "TMPDIR", "/tmp",
		"--setenv", "XDG_CONFIG_HOME", "/work/config",
		"--setenv", "SAL_USE_VCLPLUGIN", "svp",
		"--setenv", "FONTCONFIG_FILE", "/etc/fonts/fonts.conf",
		"/usr/bin/soffice", "-env:UserInstallation=file:///work/profile",
		"--headless", "--nologo", "--nodefault", "--norestore",
		"--convert-to", "pdf", "--outdir", "/work/out", "/work/source" + ext,
	}
	cmd := exec.CommandContext(convertCtx, "/usr/bin/bwrap", args...)
	cmd.WaitDelay = 2 * time.Second
	log := &limitedOfficeLog{}
	cmd.Stdout = log
	cmd.Stderr = log
	if err = cmd.Run(); err != nil {
		return nil, fmt.Errorf("isolated office render failed: %w (%s)", err, log.String())
	}
	pdfFile := filepath.Join(work, "out", "source.pdf")
	stat, err := os.Stat(pdfFile)
	if err != nil {
		return nil, fmt.Errorf("office output unavailable: %w (%s)", err, log.String())
	}
	if stat.Size() < 8 || stat.Size() > maxOfficePDFBytes {
		return nil, errors.New("converted PDF outside preview limits")
	}
	pdf, err := os.ReadFile(pdfFile)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(string(pdf[:min(len(pdf), 8)]), "%PDF-") {
		return nil, errors.New("converted file is not PDF")
	}
	return pdf, nil
}

type limitedOfficeLog struct {
	mu   sync.Mutex
	data []byte
}

func (l *limitedOfficeLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := len(p)
	if len(l.data) < 4096 {
		l.data = append(l.data, p[:min(n, 4096-len(l.data))]...)
	}
	return n, nil
}

func (l *limitedOfficeLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return string(l.data)
}
