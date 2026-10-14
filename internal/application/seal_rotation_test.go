package application

import (
	"bytes"
	"context"
	"filesmanage/internal/domain"
	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
	"image"
	"image/color"
	"image/png"
	"math"
	"strings"
	"testing"
)

func TestSealRotationCenterAndBounds(t *testing.T) {
	mark := SealPlacement{PageNumber: 1, X: .4, Y: .4, Width: .2, Height: .1}
	for _, angle := range []float64{-180, -90, -33, 0, 45, 90, 180} {
		mark.AngleDegrees = angle
		if !rotatedSealFits(612, 792, mark) {
			t.Fatalf("centered %g rejected", angle)
		}
	}
	mark.X = .01
	mark.Y = .01
	mark.AngleDegrees = 45
	if rotatedSealFits(612, 792, mark) {
		t.Fatal("rotated corner outside page was accepted")
	}
	mark.X = .4
	mark.Y = .4
	mark.AngleDegrees = 181
	if normalizedSealPosition(mark) {
		t.Fatal("out of range rotation accepted")
	}
	mark.AngleDegrees = math.Inf(1)
	if normalizedSealPosition(mark) {
		t.Fatal("nonfinite rotation accepted")
	}
	mark.AngleDegrees = math.NaN()
	if normalizedSealPosition(mark) {
		t.Fatal("NaN rotation accepted")
	}
	mark.AngleDegrees = 0
	if !normalizedSealPosition(mark) {
		t.Fatal("zero angle rejected")
	}
}

func TestSealRotationExportDirection(t *testing.T) {
	m := domain.FileSealMark{X: .6, Y: .3, Width: .2, Height: .1, AngleDegrees: 90}
	spec := sealWatermarkSpec(m, 600, 800)
	if !strings.Contains(spec, "pos:c") || !strings.Contains(spec, "rot:-90.00") {
		t.Fatalf("PDF rotation should match clockwise UI convention: %s", spec)
	}
	if !strings.Contains(spec, "off:120.0000 120.0000") {
		t.Fatalf("wrong center anchor: %s", spec)
	}
	m.AngleDegrees = 0
	if !strings.HasSuffix(sealWatermarkSpec(m, 600, 800), "rot:-0.00") {
		t.Fatal("legacy zero rotation was not retained")
	}
}

func TestSealRotationPDFcpuAcceptsCenterPivot(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 40, 30))
	img.Set(12, 10, color.RGBA{R: 255, A: 255})
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	mark := domain.FileSealMark{X: .6, Y: .3, Width: .2, Height: .1, AngleDegrees: 90}
	watermark, err := api.ImageWatermarkForReader(context.Background(), bytes.NewReader(b.Bytes()), sealWatermarkSpec(mark, 600, 800), true, false, types.POINTS)
	if err != nil {
		t.Fatalf("pdfcpu rejected center-anchored stamp: %v", err)
	}
	if watermark.Rotation != -90 || watermark.Pos != types.Center {
		t.Fatalf("wrong pivot/rotation: %v %v", watermark.Pos, watermark.Rotation)
	}
}
