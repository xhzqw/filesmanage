package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/png"
	"io"
	"math"

	"filesmanage/internal/domain"
	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
	"golang.org/x/image/draw"
)

const maxSignedPDFBytes = 24 << 20
const maxSignedPDFMarks = 120

// SignedPDFExport is a DERIVATIVE, not a new source version and not a
// certificate-backed cryptographic signature (CMS/PAdES). It overlays only
// immutable, password-confirmed evidence already saved for this exact version.
type SignedPDFExport struct {
	FileName     string
	SourceSha256 string
	Data         []byte
}

func renderSealStampPNG(raw []byte, width, height float64) ([]byte, error) {
	// pdfcpu uses image pixel dimensions as point dimensions for absolute scale
	// 1, so make pixels equal requested PDF point dimensions.
	w, h := int(math.Round(width)), int(math.Round(height))
	if w < 1 || h < 1 || w > 2200 || h > 2200 || w*h > 3000000 {
		return nil, ErrInvalidInput
	}
	source, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, ErrInvalidInput
	}
	dst := image.NewNRGBA(image.Rect(0, 0, w, h))
	draw.ApproxBiLinear.Scale(dst, dst.Bounds(), source, source.Bounds(), draw.Over, nil)
	var out bytes.Buffer
	if err = png.Encode(&out, dst); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func (s *Service) ExportSignedPDF(ctx context.Context, actor domain.User, fileID string, seq int) (SignedPDFExport, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return SignedPDFExport{}, err
	}
	defer tx.Rollback(ctx)
	if seq < 1 {
		return SignedPDFExport{}, ErrInvalidInput
	}
	file, err := s.visibleFile(ctx, tx, actor, fileID, domain.ActionPrint)
	if err != nil {
		return SignedPDFExport{}, err
	}
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return SignedPDFExport{}, err
	}
	if extensionOf(file.Name) != ".pdf" {
		return SignedPDFExport{}, ErrPreviewUnsupported
	}
	version, err := tx.VersionBySeq(ctx, fileID, seq)
	if err != nil {
		return SignedPDFExport{}, domain.ErrNotFound
	}
	if version.SizeBytes < 20 || version.SizeBytes > maxSignedPDFBytes {
		return SignedPDFExport{}, ErrPreviewUnsupported
	}
	blob, err := tx.BlobByID(ctx, version.BlobID)
	if err != nil {
		return SignedPDFExport{}, domain.ErrNotFound
	}
	source, err := s.blobs.Open(blob.StorageKey)
	if err != nil {
		return SignedPDFExport{}, err
	}
	original, readErr := io.ReadAll(io.LimitReader(source, maxSignedPDFBytes+1))
	source.Close()
	if readErr != nil {
		return SignedPDFExport{}, readErr
	}
	if int64(len(original)) != version.SizeBytes || !bytes.HasPrefix(original, []byte("%PDF-")) {
		return SignedPDFExport{}, ErrPreviewUnsupported
	}
	digest := sha256.Sum256(original)
	if hex.EncodeToString(digest[:]) != version.Sha256 {
		return SignedPDFExport{}, domain.ErrVersionConflict
	}
	store, err := sealRepository(tx)
	if err != nil {
		return SignedPDFExport{}, err
	}
	marks, err := store.ListSealMarks(ctx, fileID, seq)
	if err != nil {
		return SignedPDFExport{}, err
	}
	if len(marks) == 0 || len(marks) > maxSignedPDFMarks {
		return SignedPDFExport{}, ErrInvalidInput
	}
	dims, err := api.PageDims(ctx, bytes.NewReader(original), nil)
	if err != nil {
		return SignedPDFExport{}, ErrPreviewUnsupported
	}
	stampByPage := map[int][]*model.Watermark{}
	for _, m := range marks {
		if m.FileSha256 != version.Sha256 || m.PageNumber < 1 || m.PageNumber > len(dims) {
			return SignedPDFExport{}, domain.ErrVersionConflict
		}
		dim := dims[m.PageNumber-1]
		if dim.Width < 1 || dim.Height < 1 || dim.Width > 5000 || dim.Height > 5000 {
			return SignedPDFExport{}, ErrPreviewUnsupported
		}
		asset, raw, err := store.GetSeal(ctx, m.AssetID)
		if err != nil || asset.Sha256 != m.AssetSha256 {
			return SignedPDFExport{}, domain.ErrVersionConflict
		}
		// Normalized coordinates are measured from top-left of the actual page.
		scaled, err := renderSealStampPNG(raw, m.Width*dim.Width, m.Height*dim.Height)
		if err != nil {
			return SignedPDFExport{}, err
		}
		spec := sealWatermarkSpec(m, dim.Width, dim.Height)
		wm, err := api.ImageWatermarkForReader(ctx, bytes.NewReader(scaled), spec, true, false, types.POINTS)
		if err != nil {
			return SignedPDFExport{}, err
		}
		stampByPage[m.PageNumber] = append(stampByPage[m.PageNumber], wm)
	}
	if err = tx.Rollback(ctx); err != nil {
		return SignedPDFExport{}, err
	}
	var output bytes.Buffer
	if err = api.AddWatermarksSliceMap(ctx, bytes.NewReader(original), &output, stampByPage, nil); err != nil {
		if errors.Is(err, context.Canceled) {
			return SignedPDFExport{}, ctx.Err()
		}
		return SignedPDFExport{}, ErrPreviewUnsupported
	}
	if output.Len() == 0 || output.Len() > 40<<20 {
		return SignedPDFExport{}, ErrPreviewUnsupported
	}
	return SignedPDFExport{FileName: file.Name, SourceSha256: version.Sha256, Data: output.Bytes()}, nil
}
