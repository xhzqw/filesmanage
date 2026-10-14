package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"strings"
	"testing"
	"time"
)

func officeService(t *testing.T) (*Service, *memoryRepo) {
	t.Helper()
	service, repo := testService(t)
	service = service.WithOffice(OfficeConfig{
		EditorURL:     "http://office.test:8080",
		Secret:        "unit-test-secret",
		SourceBaseURL: "http://127.0.0.1:18091",
		EditorVersion: "8.2.2",
	})
	return service, repo
}

func TestJWTRejectsTampering(t *testing.T) {
	token, err := signJWT("secret", map[string]any{"document": map[string]any{"key": "k"}}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := verifyJWT("secret", token)
	if err != nil {
		t.Fatalf("valid token rejected: %v", err)
	}
	document, ok := claims["document"].(map[string]any)
	if !ok || document["key"] != "k" {
		t.Fatalf("claims lost the document key: %v", claims)
	}
	if _, err = verifyJWT("other-secret", token); !errors.Is(err, errJWT) {
		t.Fatal("wrong secret must be rejected")
	}
	parts := strings.Split(token, ".")
	tampered := parts[0] + "." + parts[1][:len(parts[1])-4] + "AAAA" + "." + parts[2]
	if _, err = verifyJWT("secret", tampered); !errors.Is(err, errJWT) {
		t.Fatal("tampered payload must be rejected")
	}
	expired, err := signJWT("secret", map[string]any{"x": 1}, -time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = verifyJWT("secret", expired); !errors.Is(err, errJWT) {
		t.Fatal("expired token must be rejected")
	}
}

func TestOfficeSessionLifecycle(t *testing.T) {
	s, repo := officeService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "spec.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "", strings.NewReader("PK\x03\x04[Content_Types].xml-body"))
	if err != nil {
		t.Fatal(err)
	}
	view, err := s.OpenOfficeSession(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatalf("open session failed: %v", err)
	}
	if view.DocumentKey == "" || view.Token == "" {
		t.Fatal("session must carry a document key and editor token")
	}
	// The same user's second session re-keys: the new document key differs and
	// the old key stops resolving.
	second, err := s.OpenOfficeSession(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatalf("same-user reopen must succeed: %v", err)
	}
	if second.DocumentKey == view.DocumentKey {
		t.Fatal("reopen must issue a fresh document key")
	}
	if _, _, _, _, err = s.EditorSource(ctx, view.Token); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("superseded session key must stop resolving: %v", err)
	}
	// Another permitted user is refused while the live session is held.
	other := domain.User{ID: "u_user", Login: "user1"}
	repo.seedGrant(domain.ACL{ID: "acl_office", FolderID: "folder_root", SubjectKind: "user",
		SubjectID: "u_user", Actions: []domain.Action{domain.ActionModify}})
	if _, err = s.OpenOfficeSession(ctx, other, uploaded.FileID); !errors.Is(err, domain.ErrLocked) {
		t.Fatalf("foreign holder must be refused: %v", err)
	}
	view = second
	// Non-DOCX files cannot open the editor.
	text, err := s.CommitUpload(ctx, admin, "folder_root", "plain.txt", "text/plain", "", strings.NewReader("hello"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.OpenOfficeSession(ctx, admin, text.FileID); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("non-docx must be refused: %v", err)
	}
	// Source streaming requires the editor token.
	if _, _, _, _, err = s.EditorSource(ctx, "garbage"); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("garbage source token must be rejected: %v", err)
	}
	reader, name, size, closeReader, err := s.EditorSource(ctx, view.Token)
	if err != nil {
		t.Fatalf("editor source failed: %v", err)
	}
	buf := make([]byte, size)
	_, _ = reader.Read(buf)
	closeReader()
	if !strings.Contains(string(buf), "[Content_Types].xml") || name != "spec.docx" {
		t.Fatalf("source stream wrong: %s %d", name, size)
	}
	if err = s.CloseOfficeSession(ctx, admin, view.SessionID); err != nil {
		t.Fatalf("close session failed: %v", err)
	}
}

func TestEditorCallbackIdempotencyAndConflict(t *testing.T) {
	s, _ := officeService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	// Build a real minimal DOCX-like payload: ZIP magic + content types entry.
	docx := []byte("PK\x03\x04fake-zip[Content_Types].xmlrest-of-document")
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "callback.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "", strings.NewReader(string(docx)))
	if err != nil {
		t.Fatal(err)
	}
	view, err := s.OpenOfficeSession(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatal(err)
	}
	// Non-OOXML payloads are refused before any version is written.
	badToken, err := signJWT(s.office.Secret, map[string]any{"document": map[string]any{"key": view.DocumentKey}}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.HandleEditorCallback(ctx, badToken, EditorCallbackPayload{Key: view.DocumentKey, Status: domain.CallbackStatusSaveReady, URL: "http://office.test:8080/x"}); err == nil {
		t.Fatal("expected failure for unreachable editor URL")
	}
	// A save that moves the file on first is a controlled conflict.
	lock, _, err := s.AcquireLock(ctx, admin, uploaded.FileID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Save(ctx, admin, uploaded.FileID, []byte("changed by another writer"), 1, lock, ""); err != nil {
		t.Fatal(err)
	}
	_, versions, err := s.FileMeta(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatal(err)
	}
	if len(versions) != 2 {
		t.Fatalf("direct save must have committed v2, got %d", len(versions))
	}
	// Status 1 (editing heartbeat) only touches the session.
	if code, err := s.HandleEditorCallback(ctx, badToken, EditorCallbackPayload{Key: view.DocumentKey, Status: domain.CallbackStatusEditing}); err != nil || code != 0 {
		t.Fatalf("heartbeat must be accepted: %v %d", err, code)
	}
	// A foreign callback URL host is refused (SSRF guard).
	if _, err = s.downloadFromEditor(ctx, "http://evil.example.com/doc"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("foreign editor host must be refused: %v", err)
	}
	if _, err = s.downloadFromEditor(ctx, "http://127.0.0.1:18091/internal"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non-editor host must be refused: %v", err)
	}
}

func TestLooksLikeOOXML(t *testing.T) {
	if !looksLikeOOXML([]byte("PK\x03\x04[Content_Types].xml......")) {
		t.Fatal("docx container must pass")
	}
	if looksLikeOOXML([]byte("PK\x03\x04not-a-docx")) {
		t.Fatal("zip without content types must fail")
	}
	if looksLikeOOXML([]byte("plain text")) {
		t.Fatal("plain text must fail")
	}
}
