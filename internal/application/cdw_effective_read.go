package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"time"
)

// resolveUserFacingVersion is shared by preview and download. Only an
// effective-pointer-backed released artifact may replace the ordinary latest
// version. No fallback is allowed if a managed pointer is withdrawn, invalid
// or refers to a missing or corrupted immutable blob.
func (s *Service) resolveUserFacingVersion(ctx context.Context, tx ports.Tx,
	actor domain.User, action domain.Action, file domain.File) (domain.File, domain.Blob, time.Time, error) {
	if store, ok := tx.(ports.CDWEffectiveReadStore); ok {
		controlled, managed, err := store.CDWEffectiveRead(ctx, file.ID, actor.ID, action)
		if err != nil {
			return file, domain.Blob{}, time.Time{}, err
		}
		if managed {
			blob, err := tx.BlobByID(ctx, controlled.BlobID)
			if err != nil {
				return file, domain.Blob{}, time.Time{}, domain.ErrConflict
			}
			if blob.State != "ready" || blob.Sha256 != controlled.SHA256 {
				return file, domain.Blob{}, time.Time{}, domain.ErrConflict
			}
			file.Name = controlled.FileName
			file.ContentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
			file.Sha256 = blob.Sha256
			file.SizeBytes = blob.SizeBytes
			file.UpdatedAt = controlled.EffectiveAt
			return file, blob, controlled.EffectiveAt, nil
		}
	}
	version, err := tx.VersionBySeq(ctx, file.ID, currentSeq(file))
	if err != nil {
		return file, domain.Blob{}, time.Time{}, domain.ErrNotFound
	}
	blob, err := tx.BlobByID(ctx, version.BlobID)
	if err != nil {
		return file, domain.Blob{}, time.Time{}, domain.ErrNotFound
	}
	return file, blob, version.CreatedAt, nil
}
