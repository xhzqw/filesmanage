package application

import (
	"bytes"
	"context"
	"errors"
	"fmt"

	"filesmanage/internal/domain"
)

// The source ID, version and lineage are stored in FileLineage, not filenames.
func friendlyConversionName(base, target string, sourceSeq, collision int) string {
	marker := "转换件"
	if target == "pdf" {
		marker = "签署件"
	}
	suffix := fmt.Sprintf("-%s-v%d", marker, sourceSeq)
	if collision > 0 {
		suffix += fmt.Sprintf("(%d)", collision)
	}
	suffix += "." + target
	runes := []rune(base)
	for len(string(runes))+len(suffix) > 195 && len(runes) > 0 {
		runes = runes[:len(runes)-1]
	}
	return string(runes) + suffix
}

// Every attempt still checks access and name uniqueness in a transaction.
// Reusing the idempotency key returns the original descendant if it exists.
func (s *Service) commitFriendlyConversion(ctx context.Context, u domain.User, folderID, base, target string,
	sourceSeq int, mime, key string, content []byte, lineage *domain.FileLineage) (UploadResult, error) {
	for i := 0; i < 100; i++ {
		name := friendlyConversionName(base, target, sourceSeq, i)
		result, err := s.commitUploadWithLineage(ctx, u, folderID, name, mime, key, bytes.NewReader(content), lineage)
		if errors.Is(err, domain.ErrNameConflict) {
			continue
		}
		return result, err
	}
	return UploadResult{}, domain.ErrNameConflict
}
