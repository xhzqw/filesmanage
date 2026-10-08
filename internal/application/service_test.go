package application

import (
	"bytes"
	"context"
	"io"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"golang.org/x/crypto/bcrypt"
	"strings"
	"testing"
	"time"
)

// memoryBlob is an in-memory ports.BlobStore keyed by content digest.
type memoryBlob struct {
	data map[string][]byte
}

func newMemoryBlob() *memoryBlob { return &memoryBlob{data: map[string][]byte{}} }

func (m *memoryBlob) Stage() (ports.BlobStage, error) { return &memoryStage{store: m}, nil }

func (m *memoryBlob) Open(key string) (io.ReadSeekCloser, error) {
	data, ok := m.data[key]
	if !ok {
		return nil, errors.New("blob missing")
	}
	return seekableReader{bytes.NewReader(data)}, nil
}

// seekableReader adds a no-op Close/Seek pair around bytes.Reader so the fake
// store matches ports.BlobStore without a real file.
type seekableReader struct{ *bytes.Reader }

func (seekableReader) Close() error { return nil }

type memoryStage struct {
	store *memoryBlob
	buf   bytes.Buffer
	key   string
	done  bool
}

func (s *memoryStage) Write(p []byte) (int, error) { return s.buf.Write(p) }
func (s *memoryStage) Size() int64                 { return int64(s.buf.Len()) }
func (s *memoryStage) Sha256() string              { return s.key }
func (s *memoryStage) Commit() (string, bool, error) {
	if s.done {
		return "", false, errors.New("already finalized")
	}
	s.done = true
	sum := sha256Hex(s.buf.Bytes())
	s.key = sum
	if _, exists := s.store.data[sum]; exists {
		return sum, true, nil
	}
	s.store.data[sum] = append([]byte{}, s.buf.Bytes()...)
	return sum, false, nil
}
func (s *memoryStage) Abort() error { s.done = true; return nil }

func sha256Hex(data []byte) string {
	sum := sha256Sum(data)
	return sum
}

func testService(t *testing.T) (*Service, *memoryRepo) {
	t.Helper()
	repo := newMemoryRepo()
	hash, err := bcrypt.GenerateFromPassword([]byte("long-unit-test-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	repo.seedUser(domain.User{ID: "u_admin", Login: "admin", DisplayName: "系统管理员", IsAdmin: true}, string(hash))
	repo.seedUser(domain.User{ID: "u_user", Login: "user1", DisplayName: "普通用户"}, string(hash))
	root := domain.Folder{ID: "folder_root", Name: "中晟生物科技", OwnerID: "u_admin"}
	repo.seedFolder(root)
	child := domain.Folder{ID: "folder_market", Name: "市场部", ParentID: &root.ID, OwnerID: "u_admin"}
	repo.seedFolder(child)
	service := New(repo, newMemoryBlob()).WithClock(func() time.Time {
		return time.Date(2026, 10, 8, 13, 0, 0, 0, time.UTC)
	})
	return service, repo
}

func TestLoginSessionLogout(t *testing.T) {
	s, repo := testService(t)
	if _, _, err := s.Login(context.Background(), "admin", "wrong"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("wrong password should reject: %v", err)
	}
	token, u, err := s.Login(context.Background(), "admin", "long-unit-test-password")
	if err != nil || len(token) != 43 || u.ID != "u_admin" {
		t.Fatalf("login failed: %v", err)
	}
	if _, err = s.Session(context.Background(), token); err != nil {
		t.Fatalf("session not found %v", err)
	}
	if _, err = s.Session(context.Background(), "bad"); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("bad token accepted")
	}
	if err = s.Logout(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Session(context.Background(), token); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("revoked token accepted")
	}
	_ = repo
}

func TestSessionExpiry(t *testing.T) {
	s, repo := testService(t)
	hash := HashToken("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	if err := repo.InsertSession(context.Background(), hash, "u_admin", time.Date(2026, 10, 8, 1, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Session(context.Background(), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("expired session accepted")
	}
}

func TestChangePasswordFlow(t *testing.T) {
	s, _ := testService(t)
	token, _, err := s.Login(context.Background(), "admin", "long-unit-test-password")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ChangePassword(context.Background(), token, "long-unit-test-password", "short"); !errors.Is(err, ErrPasswordPolicy) {
		t.Fatalf("short password must be rejected: %v", err)
	}
	if _, err = s.ChangePassword(context.Background(), token, "wrong-old", "a-very-long-new-password-1"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("wrong old password must be rejected: %v", err)
	}
	u, err := s.ChangePassword(context.Background(), token, "long-unit-test-password", "a-very-long-new-password-1")
	if err != nil || u.MustChangePassword {
		t.Fatalf("change failed: %v", err)
	}
	if _, _, err = s.Login(context.Background(), "admin", "long-unit-test-password"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatal("old password still works")
	}
	if _, _, err = s.Login(context.Background(), "admin", "a-very-long-new-password-1"); err != nil {
		t.Fatalf("new password must work: %v", err)
	}
}

func TestFolderPermissions(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	user := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()

	if _, err := s.CreateFolder(ctx, user, "folder_root", "越权目录"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("user without upload grant must be denied, got %v", err)
	}
	folder, err := s.CreateFolder(ctx, admin, "folder_root", "新目录")
	if err != nil {
		t.Fatalf("admin create failed: %v", err)
	}
	if _, err = s.RenameFolder(ctx, user, folder.ID, "改名"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("rename without grant must be denied: %v", err)
	}
	repo.seedGrant(domain.ACL{ID: "acl1", FolderID: "folder_root", SubjectKind: "user", SubjectID: "u_user", Actions: []domain.Action{domain.ActionList, domain.ActionRename}})
	if _, err = s.RenameFolder(ctx, user, folder.ID, "授权改名"); err != nil {
		t.Fatalf("granted rename failed: %v", err)
	}
	if _, err = s.RenameFolder(ctx, user, folder.ID, ""); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("empty name must be rejected: %v", err)
	}
}

func TestUploadSaveRollbackAppendOnly(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()

	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "spec.txt", "text/plain", "", strings.NewReader("A"))
	if err != nil {
		t.Fatalf("upload failed: %v", err)
	}
	if uploaded.VersionSeq != 1 || uploaded.Size != 1 {
		t.Fatalf("unexpected upload result %+v", uploaded)
	}
	if _, err = s.CommitUpload(ctx, admin, "folder_root", "spec.txt", "text/plain", "", strings.NewReader("B")); !errors.Is(err, domain.ErrNameConflict) {
		t.Fatalf("duplicate name must conflict: %v", err)
	}

	// Dedup: identical content reuses the ready blob.
	second, err := s.CommitUpload(ctx, admin, "folder_market", "copy.txt", "text/plain", "", strings.NewReader("A"))
	if err != nil {
		t.Fatalf("second upload failed: %v", err)
	}
	if !second.Dedup || second.Sha256 != uploaded.Sha256 {
		t.Fatalf("identical content must deduplicate: %+v", second)
	}

	// Stale CAS is rejected.
	if _, err = s.Save(ctx, admin, uploaded.FileID, []byte("stale"), 99, ""); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("stale baseSeq must conflict: %v", err)
	}

	// v1(A) -> v2(B) -> v3(C), then append-only rollback to v1.
	v2, err := s.Save(ctx, admin, uploaded.FileID, []byte("B"), 1, "")
	if err != nil {
		t.Fatalf("save v2 failed: %v", err)
	}
	v3, err := s.Save(ctx, admin, uploaded.FileID, []byte("C"), v2.VersionSeq, "")
	if err != nil {
		t.Fatalf("save v3 failed: %v", err)
	}
	rolled, err := s.Rollback(ctx, admin, uploaded.FileID, 1, v3.VersionSeq, "恢复误修改", "")
	if err != nil {
		t.Fatalf("rollback failed: %v", err)
	}
	if rolled.VersionSeq != 4 {
		t.Fatalf("rollback must append v4, got %d", rolled.VersionSeq)
	}
	_, versions, err := s.FileMeta(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatal(err)
	}
	if len(versions) != 4 {
		t.Fatalf("history must keep every version, got %d", len(versions))
	}
	if versions[3].Action != domain.VersionActionRollback || versions[3].RollbackTargetSeq == nil || *versions[3].RollbackTargetSeq != 1 {
		t.Fatalf("v4 must record rollback target 1: %+v", versions[3])
	}
	if versions[0].Sha256 != rolled.Sha256 {
		t.Fatalf("v4 bytes must equal v1: %s vs %s", versions[0].Sha256, rolled.Sha256)
	}
	if versions[1].Sha256 == rolled.Sha256 || versions[2].Sha256 == rolled.Sha256 {
		t.Fatal("v2/v3 must remain untouched")
	}

	// Idempotent save replay returns the recorded version.
	replay, err := s.Save(ctx, admin, uploaded.FileID, []byte("D"), 4, "key-1")
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.Save(ctx, admin, uploaded.FileID, []byte("D"), 4, "key-1")
	if err != nil {
		t.Fatal(err)
	}
	if replay.VersionSeq != again.VersionSeq {
		t.Fatalf("idempotent replay must return same version: %d vs %d", replay.VersionSeq, again.VersionSeq)
	}
}

func TestDeleteAndRestoreFile(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "trash-me.txt", "text/plain", "", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	entry, err := s.DeleteFile(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatalf("delete failed: %v", err)
	}
	if _, _, err = s.FileMeta(ctx, admin, uploaded.FileID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("deleted file must be invisible: %v", err)
	}
	if _, err = s.RestoreFromTrash(ctx, admin, entry.ID, RestoreRequest{}); err != nil {
		t.Fatalf("restore failed: %v", err)
	}
	file, _, err := s.FileMeta(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatalf("restored file must be readable: %v", err)
	}
	if file.Name != "trash-me.txt" || file.DeletedAt != nil {
		t.Fatalf("restore must preserve identity: %+v", file)
	}
}

func TestDeleteFolderTrashesSubtreeOnce(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	if _, err := s.CreateFolder(ctx, admin, "folder_market", "子目录"); err != nil {
		t.Fatal(err)
	}
	entry, folders, err := s.DeleteFolder(ctx, admin, "folder_market")
	if err != nil {
		t.Fatalf("folder delete failed: %v", err)
	}
	if folders != 2 || entry.FolderID == nil {
		t.Fatalf("subtree must collapse into one trash entry: %+v", entry)
	}
	entries, err := s.ListTrash(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("exactly one top-level trash entry expected, got %d", len(entries))
	}
	if _, err = s.RestoreFromTrash(ctx, admin, entry.ID, RestoreRequest{}); err != nil {
		t.Fatalf("restore subtree failed: %v", err)
	}
	if _, err := repo.FolderByID(ctx, "folder_market"); err != nil {
		t.Fatal(err)
	}
}

func TestGrantsAdminOnly(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	user := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()
	if _, err := s.CreateGrant(ctx, user, "folder_root", GrantRequest{SubjectKind: "user", SubjectID: "u_user", Actions: []domain.Action{domain.ActionList}}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non-admin grant must be denied: %v", err)
	}
	if _, err := s.CreateGrant(ctx, admin, "folder_root", GrantRequest{SubjectKind: "user", SubjectID: "u_missing", Actions: []domain.Action{domain.ActionList}}); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("unknown subject must be rejected: %v", err)
	}
	if _, err := s.CreateGrant(ctx, admin, "folder_root", GrantRequest{SubjectKind: "user", SubjectID: "u_user", Actions: []domain.Action{"manage_acl"}}); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("non-file action must be rejected: %v", err)
	}
	grant, err := s.CreateGrant(ctx, admin, "folder_root", GrantRequest{SubjectKind: "user", SubjectID: "u_user", Actions: []domain.Action{domain.ActionList}})
	if err != nil {
		t.Fatalf("admin grant failed: %v", err)
	}
	if err = s.RevokeGrant(ctx, user, grant.ID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non-admin revoke must be denied: %v", err)
	}
	if err = s.RevokeGrant(ctx, admin, grant.ID); err != nil {
		t.Fatalf("admin revoke failed: %v", err)
	}
}
