package application

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"golang.org/x/crypto/bcrypt"
	"io"
	"strings"
	"time"
)

var (
	ErrUnauthorized       = errors.New("authentication required")
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrInvalidInput       = errors.New("invalid input")
	ErrPasswordPolicy     = errors.New("password must be at least 16 characters")
)

// Service orchestrates use cases. Every write runs inside one transaction
// obtained from the unit of work; blob bytes are staged outside transactions
// and only referenced inside them.
type Service struct {
	uow   ports.UnitOfWork
	blobs ports.BlobStore
	now   func() time.Time
}

func New(uow ports.UnitOfWork, blobs ports.BlobStore) *Service {
	return &Service{uow: uow, blobs: blobs, now: time.Now}
}

func (s *Service) WithClock(f func() time.Time) *Service { s.now = f; return s }

func HashToken(token string) string {
	d := sha256.Sum256([]byte(token))
	return hex.EncodeToString(d[:])
}

func mustMarshal(v any) []byte {
	raw, err := json.Marshal(v)
	if err != nil {
		return []byte("null")
	}
	return raw
}

func newRequestID() string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "req-unknown"
	}
	return "req-" + hex.EncodeToString(raw)
}

// NewID returns an opaque, collision-resistant identifier with a readable prefix.
func NewID(prefix string) string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return prefix + "_" + hex.EncodeToString(raw)
}

func newSessionToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func (s *Service) Ready(ctx context.Context) error {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	return tx.Ping(ctx)
}

// ---------- authentication ----------

func (s *Service) Login(ctx context.Context, login, password string) (string, domain.User, error) {
	login = strings.TrimSpace(login)
	if len(login) < 1 || len(login) > 80 || len(password) == 0 || len(password) > 1024 {
		return "", domain.User{}, ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return "", domain.User{}, err
	}
	defer tx.Rollback(ctx)
	u, hash, err := tx.UserByLogin(ctx, login)
	if err != nil {
		return "", domain.User{}, ErrInvalidCredentials
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return "", domain.User{}, ErrInvalidCredentials
	}
	token, err := newSessionToken()
	if err != nil {
		return "", domain.User{}, err
	}
	if err = tx.InsertSession(ctx, HashToken(token), u.ID, s.now().Add(24*time.Hour)); err != nil {
		return "", domain.User{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", domain.User{}, err
	}
	return token, u, nil
}

func (s *Service) Session(ctx context.Context, token string) (domain.Authenticated, error) {
	if len(token) != 43 {
		return domain.Authenticated{}, ErrUnauthorized
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.Authenticated{}, err
	}
	defer tx.Rollback(ctx)
	a, err := tx.UserBySessionHash(ctx, HashToken(token))
	if err != nil || !a.ExpiresAt.After(s.now()) {
		return domain.Authenticated{}, ErrUnauthorized
	}
	return a, nil
}

func (s *Service) Logout(ctx context.Context, token string) error {
	if len(token) != 43 {
		return ErrUnauthorized
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = tx.RevokeSession(ctx, HashToken(token)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) ChangePassword(ctx context.Context, sessionToken, oldPassword, newPassword string) (domain.User, error) {
	a, err := s.Session(ctx, sessionToken)
	if err != nil {
		return domain.User{}, ErrUnauthorized
	}
	if len(newPassword) < 16 || len(newPassword) > 128 {
		return domain.User{}, ErrPasswordPolicy
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.User{}, err
	}
	defer tx.Rollback(ctx)
	u, previousHash, err := tx.UserByLogin(ctx, a.User.Login)
	if err != nil || u.ID != a.User.ID {
		return domain.User{}, ErrUnauthorized
	}
	if bcrypt.CompareHashAndPassword([]byte(previousHash), []byte(oldPassword)) != nil {
		return domain.User{}, ErrInvalidCredentials
	}
	if bcrypt.CompareHashAndPassword([]byte(previousHash), []byte(newPassword)) == nil {
		return domain.User{}, ErrPasswordPolicy
	}
	newHash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return domain.User{}, err
	}
	if err = tx.ChangePassword(ctx, u.ID, previousHash, string(newHash), HashToken(sessionToken)); err != nil {
		return domain.User{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.User{}, err
	}
	u.MustChangePassword = false
	return u, nil
}

func (s *Service) Folders(ctx context.Context, u domain.User) ([]domain.Folder, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	return tx.ListVisibleFolders(ctx, u)
}

// ---------- shared helpers ----------

func allActions() map[domain.Action]bool {
	return map[domain.Action]bool{
		domain.ActionList: true, domain.ActionPreview: true, domain.ActionUpload: true,
		domain.ActionDownload: true, domain.ActionModify: true, domain.ActionDelete: true,
		domain.ActionRename: true, domain.ActionMove: true, domain.ActionPrint: true,
	}
}

// audit records a best-effort event inside the caller's transaction.
func audit(ctx context.Context, repo ports.Repository, actor domain.User, eventType, targetKind, targetID, outcome string, details map[string]any) {
	_ = repo.RecordAudit(ctx, domain.AuditEvent{
		ActorID:    actor.ID,
		EventType:  eventType,
		TargetKind: targetKind,
		TargetID:   targetID,
		RequestID:  newRequestID(),
		Outcome:    outcome,
		Details:    details,
	})
}

// idempotentResult replays a stored response for a repeated request key.
func idempotentResult(ctx context.Context, repo ports.Repository, actorID, operation, key string) ([]byte, bool, error) {
	if key == "" {
		return nil, false, nil
	}
	return repo.IdempotencyGet(ctx, actorID, operation, key)
}

func storeIdempotentResult(ctx context.Context, repo ports.Repository, actorID, operation, key string, response []byte) {
	if key == "" {
		return
	}
	_ = repo.IdempotencyPut(ctx, actorID, operation, key, response)
}

// mapError converts domain errors into transport-friendly sentinels.
func mapError(err error) error {
	switch {
	case errors.Is(err, domain.ErrNotFound), errors.Is(err, ports.ErrRowMissing):
		return domain.ErrNotFound
	case errors.Is(err, domain.ErrForbidden):
		return domain.ErrForbidden
	case errors.Is(err, domain.ErrNameConflict):
		return domain.ErrNameConflict
	case errors.Is(err, domain.ErrVersionConflict):
		return domain.ErrVersionConflict
	case errors.Is(err, domain.ErrLocked):
		return domain.ErrLocked
	case errors.Is(err, domain.ErrApprovalPending):
		return domain.ErrApprovalPending
	case errors.Is(err, domain.ErrParentMissing):
		return domain.ErrParentMissing
	case errors.Is(err, domain.ErrInvalidInput):
		return domain.ErrInvalidInput
	default:
		return err
	}
}

var _ = fmt.Sprint
var _ io.Reader
