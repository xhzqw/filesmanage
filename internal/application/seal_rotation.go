package application

import (
	"filesmanage/internal/domain"
	"fmt"
	"math"
)

// Recorded position uses normalized top-left box coordinates while rotation
// always pivots around the visual center of the unrotated mark.
func rotatedSealFits(pageWidth, pageHeight float64, p SealPlacement) bool {
	if !normalizedSealPosition(p) || pageWidth <= 0 || pageHeight <= 0 ||
		math.IsNaN(pageWidth) || math.IsNaN(pageHeight) ||
		math.IsInf(pageWidth, 0) || math.IsInf(pageHeight, 0) {
		return false
	}
	radians := p.AngleDegrees * math.Pi / 180
	c, ss := math.Abs(math.Cos(radians)), math.Abs(math.Sin(radians))
	halfX := (p.Width*c + p.Height*pageHeight/pageWidth*ss) / 2
	halfY := (p.Height*c + p.Width*pageWidth/pageHeight*ss) / 2
	cx, cy := p.X+p.Width/2, p.Y+p.Height/2
	const eps = 0.00000001
	return cx-halfX >= -eps && cx+halfX <= 1+eps && cy-halfY >= -eps && cy+halfY <= 1+eps
}

// PDF coordinates are bottom-left Y-up; the UI is top-left Y-down and a
// positive UI angle is clockwise. pdfcpu's positive angle is counterclockwise.
// Center anchoring avoids special-case 90-degree page-edge alignment in
// pdfcpu for non-center positions.
func sealWatermarkSpec(mark domain.FileSealMark, pageWidth, pageHeight float64) string {
	centerX := (mark.X + mark.Width/2 - 0.5) * pageWidth
	centerY := (0.5 - mark.Y - mark.Height/2) * pageHeight
	return fmt.Sprintf("pos:c, off:%.4f %.4f, scale:1 abs, rot:%.2f", centerX, centerY, -mark.AngleDegrees)
}
