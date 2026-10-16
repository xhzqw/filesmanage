package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"testing"
	"time"
)

type cdwEffectiveReadFake struct {
	ports.Tx
	managed       bool
	projection    ports.CDWEffectiveRead
	projectionErr error
	current       domain.FileVersion
	blob          domain.Blob
	versionCalls  int
}

func (f *cdwEffectiveReadFake) CDWEffectiveRead(_ context.Context, _ string) (ports.CDWEffectiveRead, bool, error) {
	return f.projection, f.managed, f.projectionErr
}
func (f *cdwEffectiveReadFake) VersionBySeq(_ context.Context, _ string, _ int) (domain.FileVersion, error) {
	f.versionCalls++
	return f.current, nil
}
func (f *cdwEffectiveReadFake) BlobByID(_ context.Context, id string) (domain.Blob, error) {
	if f.blob.ID != id {
		return domain.Blob{}, ports.ErrRowMissing
	}
	return f.blob, nil
}
func TestCDWEffectiveReadNeverFallsBackToLatestOnManagedFailure(t *testing.T) {
	ctx := context.Background()
	seq := 7
	file := domain.File{ID: "file1", Name: "ordinary.docx", CurrentVersionSeq: &seq, ContentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
	effectiveTime := time.Date(2026, 10, 16, 6, 30, 0, 0, time.UTC)
	f := &cdwEffectiveReadFake{
		managed: true,
		projection: ports.CDWEffectiveRead{BlobID: "issued-blob", SHA256: "approved-sha",
			FileName: "受控正式稿.docx", Format: "docx", EffectiveAt: effectiveTime},
		blob:    domain.Blob{ID: "issued-blob", Sha256: "approved-sha", State: "ready", SizeBytes: 42},
		current: domain.FileVersion{BlobID: "ordinary-blob", CreatedAt: effectiveTime.Add(-time.Hour)},
	}
	service := &Service{}
	chosen, blob, when, err := service.resolveUserFacingVersion(ctx, f, file)
	if err != nil || blob.ID != "issued-blob" || chosen.Name != "受控正式稿.docx" ||
		chosen.Sha256 != "approved-sha" || !when.Equal(effectiveTime) || f.versionCalls != 0 {
		t.Fatalf("active pointer not authoritative: file=%+v blob=%+v when=%v err=%v versionReads=%d", chosen, blob, when, err, f.versionCalls)
	}
	f.projectionErr = domain.ErrConflict
	_, _, _, err = service.resolveUserFacingVersion(ctx, f, file)
	if !errors.Is(err, domain.ErrConflict) || f.versionCalls != 0 {
		t.Fatalf("invalid/none pointer leaked latest ordinary upload: %v; latest reads=%d", err, f.versionCalls)
	}
	f.projectionErr = nil
	f.blob.Sha256 = "corrupt-sha"
	_, _, _, err = service.resolveUserFacingVersion(ctx, f, file)
	if !errors.Is(err, domain.ErrConflict) || f.versionCalls != 0 {
		t.Fatalf("corrupt controlled artifact leaked latest ordinary upload: %v; latest reads=%d", err, f.versionCalls)
	}
	f.managed = false
	f.blob = domain.Blob{ID: "ordinary-blob", Sha256: "latest-sha", State: "ready", SizeBytes: 50}
	unchanged, legacyBlob, _, err := service.resolveUserFacingVersion(ctx, f, file)
	if err != nil || legacyBlob.ID != "ordinary-blob" || unchanged.Name != file.Name || f.versionCalls != 1 {
		t.Fatalf("unmanaged legacy behavior changed: %+v %+v %v", unchanged, legacyBlob, err)
	}
}
