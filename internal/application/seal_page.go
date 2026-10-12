package application

import (
	"bytes"
	"context"
	"errors"
	"filesmanage/internal/domain"
	"io"
	"os"
	"os/exec"
	"time"
)

// SealPagePNG renders an exact current PDF page for visual placement, with
// the same independent print+preview checks used for file signing.
func (s *Service) SealPagePNG(ctx context.Context, actor domain.User, fileID string, seq, page int, sha string) ([]byte, error) {
	if seq < 1 || page < 1 || page > 1000 || len(sha) != 64 {
		return nil, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	file, blob, current, err := s.printSource(ctx, tx, actor, fileID, sha)
	if err != nil {
		return nil, err
	}
	if current != seq {
		return nil, domain.ErrVersionConflict
	}
	if extensionOf(file.Name) != ".pdf" || blob.SizeBytes > 20<<20 {
		return nil, ErrPreviewUnsupported
	}
	reader, err := s.blobs.Open(blob.StorageKey)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	header := make([]byte, 8)
	n, _ := io.ReadFull(reader, header)
	if n < 8 || !bytes.HasPrefix(header, []byte("%PDF-")) {
		return nil, ErrPreviewUnsupported
	}
	if _, err = reader.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	input, err := os.CreateTemp("", "seal-page-*.pdf")
	if err != nil {
		return nil, err
	}
	defer os.Remove(input.Name())
	defer input.Close()
	copied, err := io.Copy(input, io.LimitReader(reader, 20<<20+1))
	if err != nil {
		return nil, err
	}
	if copied != blob.SizeBytes {
		return nil, ErrPreviewUnsupported
	}
	if err = input.Sync(); err != nil {
		return nil, err
	}
	// One shared render slot avoids unbounded fork pressure on LAN host.
	select {
	case officeRenderSlots <- struct{}{}:
		defer func() { <-officeRenderSlots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	runCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(runCtx, "pdftoppm", "-f", itoa(page), "-l", itoa(page), "-singlefile", "-scale-to", "1080", "-png", input.Name(), "-")
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = io.Discard
	if err = cmd.Run(); err != nil {
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return nil, ErrPreviewUnsupported
		}
		return nil, ErrPreviewUnsupported
	}
	out := stdout.Bytes()
	if len(out) < 30 || len(out) > 8<<20 || !bytes.HasPrefix(out, []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
		return nil, ErrPreviewUnsupported
	}
	return out, nil
}
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [16]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
