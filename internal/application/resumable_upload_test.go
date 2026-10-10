package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"filesmanage/internal/domain"
	"testing"
)

func checksum(b []byte) string { sum := sha256.Sum256(b); return hex.EncodeToString(sum[:]) }
func TestResumableUploadOffsetPermissionsAndReplay(t *testing.T) {
	s, r := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	user := domain.User{ID: "u_user"}
	first, err := s.StartResumableUpload(ctx, admin, "folder_root", "chunked.bin", "application/octet-stream", "upload-operation-abcdef", "", 11)
	if err != nil || first.Received != 0 || first.Size != 11 {
		t.Fatalf("begin: %+v %v", first, err)
	}
	if _, err = s.ResumableStatus(ctx, user, first.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("leaked other user's private session: %v", err)
	}
	replay, err := s.StartResumableUpload(ctx, admin, "folder_root", "chunked.bin", "application/octet-stream", "upload-operation-abcdef", "", 11)
	if err != nil || replay.ID != first.ID {
		t.Fatalf("resume does not reuse upload id: %+v %v", replay, err)
	}
	if _, err = s.StartResumableUpload(ctx, admin, "folder_root", "other.bin", "application/octet-stream", "upload-operation-abcdef", "", 11); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("operation key reused with differing name: %v", err)
	}
	if _, err = s.CompleteResumableUpload(ctx, admin, first.ID); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("premature commit: %v", err)
	}
	if _, err = s.AppendResumableChunk(ctx, admin, first.ID, 0, []byte("Hello "), checksum([]byte("different"))); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("chunk checksum ignored: %v", err)
	}
	a, err := s.AppendResumableChunk(ctx, admin, first.ID, 0, []byte("Hello "), checksum([]byte("Hello ")))
	if err != nil || a.Received != 6 {
		t.Fatalf("chunk1 %+v %v", a, err)
	}
	if _, err = s.AppendResumableChunk(ctx, admin, first.ID, 0, []byte("Hello "), checksum([]byte("Hello "))); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("stale offset accepted: %v", err)
	}
	a, err = s.AppendResumableChunk(ctx, admin, first.ID, 6, []byte("world"), checksum([]byte("world")))
	if err != nil || a.Received != 11 {
		t.Fatalf("chunk2 %+v %v", a, err)
	}
	result, err := s.CompleteResumableUpload(ctx, admin, first.ID)
	if err != nil || result.VersionSeq != 1 || result.Size != 11 || result.Sha256 != checksum([]byte("Hello world")) {
		t.Fatalf("final %+v %v", result, err)
	}
	replayResult, err := s.CompleteResumableUpload(ctx, admin, first.ID)
	if err != nil || replayResult.FileID != result.FileID {
		t.Fatalf("replay double-created file: %+v %v", replayResult, err)
	}
	file, versions, err := s.FileMeta(ctx, admin, result.FileID)
	if err != nil || file.SizeBytes != 11 || len(versions) != 1 {
		t.Fatalf("incorrect committed state %+v %d %v", file, len(versions), err)
	}
	if err = s.CancelResumableUpload(ctx, admin, first.ID); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("cancelled completed file: %v", err)
	}
	if _, err = s.AppendResumableChunk(ctx, admin, first.ID, 11, []byte("x"), checksum([]byte("x"))); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("append after commit: %v", err)
	}
	// Invalid SHA after every byte is received still must not create a file.
	fail, err := s.StartResumableUpload(ctx, admin, "folder_root", "wrong.txt", "text/plain", "operation-other-abcdefgh", checksum([]byte("wrong")), 3)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.AppendResumableChunk(ctx, admin, fail.ID, 0, []byte("abc"), checksum([]byte("abc"))); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CompleteResumableUpload(ctx, admin, fail.ID); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("mismatched assembled digest committed: %v", err)
	}
	if err = s.CancelResumableUpload(ctx, admin, fail.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.StartResumableUpload(ctx, admin, "folder_root", "wrong.txt", "text/plain", "operation-other-abcdefgh", checksum([]byte("wrong")), 3); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("cancelled upload reused: %v", err)
	}
	if _, err = s.StartResumableUpload(ctx, user, "folder_market", "bad.bin", "application/octet-stream", "user-missing-acl-key", "", 4); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("unauthorized uploader: %v", err)
	}
	_ = r
}
