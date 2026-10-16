package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"testing"
	"time"
)

// These checks exercise the actual print selector with an ordinary latest
// version deliberately different from the active controlled distribution.
// The embedded Repository prevents accidental unmocked storage calls.
type controlledPrintRepository struct {
	ports.Repository
	file           domain.File
	blob           domain.Blob
	projection     ports.CDWEffectiveRead
	denied         map[domain.Action]error
	pointerManaged bool
	currentReads   int
	requests       []domain.Action
}

func (f *controlledPrintRepository) FileByID(_ context.Context, _ string) (domain.File, error) {
	return f.file, nil
}
func (f *controlledPrintRepository) FolderByID(_ context.Context, id string) (domain.Folder, error) {
	return domain.Folder{ID: id}, nil
}
func (f *controlledPrintRepository) BlobByID(_ context.Context, id string) (domain.Blob, error) {
	if id != f.blob.ID {
		return domain.Blob{}, ports.ErrRowMissing
	}
	return f.blob, nil
}
func (f *controlledPrintRepository) VersionBySeq(_ context.Context, _ string, _ int) (domain.FileVersion, error) {
	f.currentReads++
	return domain.FileVersion{BlobID: "ordinary-latest"}, nil
}
func (f *controlledPrintRepository) CDWEffectiveRead(_ context.Context, _ string, _ string, a domain.Action) (ports.CDWEffectiveRead, bool, error) {
	f.requests = append(f.requests, a)
	if e := f.denied[a]; e != nil {
		return ports.CDWEffectiveRead{}, f.pointerManaged, e
	}
	return f.projection, f.pointerManaged, nil
}
func TestCDWPrintResolvesExactEffectiveArtifactAndNeverLatest(t *testing.T) {
	ctx := context.Background()
	seq := 17
	sha := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	when := time.Date(2026, 10, 16, 3, 45, 0, 0, time.UTC)
	repo := &controlledPrintRepository{
		file: domain.File{ID: "f1", FolderID: "folder1", Name: "ordinary-latest.docx",
			CurrentVersionSeq: &seq, ContentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
		blob: domain.Blob{ID: "effective-blob", Sha256: sha, SizeBytes: 256, State: "ready"},
		projection: ports.CDWEffectiveRead{BlobID: "effective-blob", SHA256: sha,
			FileName: "受控批准版.docx", Format: "docx", EffectiveAt: when},
		pointerManaged: true,
	}
	service := &Service{}
	actor := domain.User{ID: "admin", IsAdmin: true}
	file, blob, printSeq, err := service.printSource(ctx, repo, actor, "f1", sha)
	if err != nil || printSeq != 0 || file.Name != "受控批准版.docx" ||
		!file.UpdatedAt.Equal(when) || blob.ID != "effective-blob" || repo.currentReads != 0 ||
		len(repo.requests) != 2 || repo.requests[0] != domain.ActionPrint || repo.requests[1] != domain.ActionPreview {
		t.Fatalf("controlled print fell back to latest or missed dual grant: file=%+v blob=%+v seq=%d err=%v requests=%v latestReads=%d",
			file, blob, printSeq, err, repo.requests, repo.currentReads)
	}
	if _, _, _, err = service.printSource(ctx, repo, actor, "f1",
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("stale print SHA accepted: %v", err)
	}
	repo.denied = map[domain.Action]error{domain.ActionPrint: domain.ErrForbidden}
	if _, _, _, err = service.printSource(ctx, repo, actor, "f1", sha); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("revoked print grant bypassed: %v", err)
	}
	repo.denied = map[domain.Action]error{domain.ActionPreview: domain.ErrForbidden}
	if _, _, _, err = service.printSource(ctx, repo, actor, "f1", sha); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("revoked preview grant bypassed: %v", err)
	}
	repo.denied = nil
	repo.blob.Sha256 = "invalid-blob-sha"
	if _, _, _, err = service.printSource(ctx, repo, actor, "f1", sha); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("modified immutable print blob accepted: %v", err)
	}
	repo.blob.Sha256 = sha
	repo.projection.Format = "pdf"
	if _, _, _, err = service.printSource(ctx, repo, actor, "f1", sha); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("unsupported managed format accepted: %v", err)
	}
	repo.projection.Format = "docx"
	repo.pointerManaged = false
	// Ordinary versions retain the existing path; the fake deliberately
	// exposes a missing latest version to prove no controlled-copy leak.
	if _, _, _, err = service.printSource(ctx, repo, actor, "f1", sha); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("unmanaged print did not follow ordinary version: %v", err)
	}
	if repo.currentReads != 1 {
		t.Fatalf("unexpected ordinary latest reads: %d", repo.currentReads)
	}
}
