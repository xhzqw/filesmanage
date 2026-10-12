package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"strings"
	"testing"
)

func TestExplicitReplacementAppendsImmutableVersionAndAudit(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	initial, err := s.CommitUpload(ctx, admin, "folder_market", "part.step", "application/octet-stream", "", strings.NewReader("old-cad"))
	if err != nil {
		t.Fatal(err)
	}
	target, err := s.ResolveReplaceTarget(ctx, admin, "folder_market", "part.step")
	if err != nil || target.FileID != initial.FileID || target.VersionSeq != 1 {
		t.Fatalf("wrong confirmed target %+v, %v", target, err)
	}
	replaced, err := s.ReplaceExisting(ctx, admin, target.FolderID, target.FileID, target.Name, target.VersionSeq,
		"application/octet-stream", "replace-once", strings.NewReader("new-cad"))
	if err != nil {
		t.Fatal(err)
	}
	if replaced.FileID != initial.FileID || replaced.VersionSeq != 2 || replaced.Sha256 == initial.Sha256 {
		t.Fatalf("replacement did not preserve identity or version: %+v", replaced)
	}
	again, err := s.ReplaceExisting(ctx, admin, target.FolderID, target.FileID, target.Name, target.VersionSeq,
		"application/octet-stream", "replace-once", strings.NewReader("new-cad"))
	if err != nil || again.VersionSeq != 2 {
		t.Fatalf("idempotent replay produced a new version: %+v, %v", again, err)
	}
	if _, err = s.ReplaceExisting(ctx, admin, target.FolderID, target.FileID, target.Name, target.VersionSeq,
		"application/octet-stream", "replace-twice", strings.NewReader("stale")); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("stale replacement accepted: %v", err)
	}
	file, versions, err := s.FileMeta(ctx, admin, initial.FileID)
	if err != nil || currentSeq(file) != 2 || len(versions) != 2 || versions[0].Sha256 != initial.Sha256 || versions[1].Sha256 != replaced.Sha256 {
		t.Fatalf("original version lost: file=%+v versions=%+v err=%v", file, versions, err)
	}
	history, err := s.FileHistory(ctx, admin, initial.FileID, "", 20)
	if err != nil || len(history.Items) != 2 || history.Items[0].EventType != "file.replace" {
		t.Fatalf("replacement audit missing: %+v %v", history, err)
	}
	if history.Items[0].Details["oldSha256"] != initial.Sha256 ||
		history.Items[0].Details["versionSeq"] != 2 {
		t.Fatalf("replacement before/after evidence incorrect: %+v", history.Items[0].Details)
	}
}

func TestExplicitReplacementRespectsFileLocksAndPermissions(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	viewer := domain.User{ID: "u_user"}
	initial, err := s.CommitUpload(ctx, admin, "folder_market", "protected.step", "application/octet-stream", "", strings.NewReader("old"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ResolveReplaceTarget(ctx, viewer, "folder_market", "protected.step"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("replacement preflight exposed file to unauthorized user: %v", err)
	}
	if _, err = s.ReplaceExisting(ctx, viewer, "folder_market", initial.FileID, "protected.step", 1,
		"application/octet-stream", "", strings.NewReader("secret")); err == nil {
		t.Fatal("unauthorized replacement accepted")
	}
	token, _, err := s.AcquireLock(ctx, admin, initial.FileID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ResolveReplaceTarget(ctx, admin, "folder_market", "protected.step"); !errors.Is(err, domain.ErrLocked) {
		t.Fatalf("active edit lock did not block preflight: %v", err)
	}
	if _, err = s.ReplaceExisting(ctx, admin, "folder_market", initial.FileID, "protected.step", 1,
		"application/octet-stream", "", strings.NewReader("lock-bypass")); !errors.Is(err, domain.ErrLocked) {
		t.Fatalf("replacement bypassed edit lock: %v", err)
	}
	if err = s.ReleaseLock(ctx, admin, initial.FileID, token); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ResolveReplaceTarget(ctx, admin, "folder_market", "protected.step"); err != nil {
		t.Fatalf("replacement did not reopen after release: %v", err)
	}
}

func TestDownloadHistoryIsPreparationNotTransferCompletion(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	ids := make([]string, 0, 4)
	for i, name := range []string{"a.txt", "b.txt", "c.txt", "d.txt"} {
		created, err := s.CommitUpload(ctx, admin, "folder_market", name, "text/plain", "", strings.NewReader(name))
		if err != nil {
			t.Fatal(i, err)
		}
		ids = append(ids, created.FileID)
	}
	if _, err := s.InspectDownloadBatch(ctx, admin, ids); err != nil {
		t.Fatal(err)
	}
	history, err := s.FileHistory(ctx, admin, ids[1], "", 30)
	if err != nil || len(history.Items) != 1 {
		t.Fatalf("HEAD-like preflight logged download: %+v %v", history, err)
	}
	single, closeSingle, err := s.OpenDownload(ctx, admin, ids[1])
	if err != nil || single.Size == 0 {
		t.Fatalf("single prepared download: %+v %v", single, err)
	}
	closeSingle()
	bundle, closeBundle, err := s.OpenDownloadBatch(ctx, admin, ids)
	if err != nil || len(bundle) != 4 {
		t.Fatalf("zip prepared download: %+v %v", bundle, err)
	}
	closeBundle()
	history, err = s.FileHistory(ctx, admin, ids[1], "", 30)
	if err != nil || len(history.Items) != 3 ||
		history.Items[0].EventType != "file.download_zip_prepare" ||
		history.Items[1].EventType != "file.download_prepare" {
		t.Fatalf("download preparation history missing: %+v %v", history, err)
	}
}
