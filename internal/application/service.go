package application

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"golang.org/x/crypto/bcrypt"
	"strings"
	"time"
)

var (
	ErrUnauthorized       = errors.New("authentication required")
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrInvalidInput       = errors.New("invalid input")
)

type Service struct {
	repo ports.Repository
	now  func() time.Time
}

func New(repo ports.Repository) *Service                 { return &Service{repo: repo, now: time.Now} }
func (s *Service) WithClock(f func() time.Time) *Service { s.now = f; return s }
func HashToken(token string) string {
	d := sha256.Sum256([]byte(token))
	return hex.EncodeToString(d[:])
}
func (s *Service) Login(ctx context.Context, login, password string) (string, domain.User, error) {
	login = strings.TrimSpace(login)
	if len(login) < 1 || len(login) > 80 || len(password) == 0 || len(password) > 1024 {
		return "", domain.User{}, ErrInvalidInput
	}
	u, hash, err := s.repo.UserByLogin(ctx, login)
	if err != nil {
		// bcrypt timing padding is a later hardening requirement; no account enumeration response.
		return "", domain.User{}, ErrInvalidCredentials
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return "", domain.User{}, ErrInvalidCredentials
	}
	raw := make([]byte, 32)
	if _, err = rand.Read(raw); err != nil {
		return "", domain.User{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	if err = s.repo.InsertSession(ctx, HashToken(token), u.ID, s.now().Add(24*time.Hour)); err != nil {
		return "", domain.User{}, err
	}
	return token, u, nil
}
func (s *Service) Session(ctx context.Context, token string) (domain.Authenticated, error) {
	if len(token) != 43 {
		return domain.Authenticated{}, ErrUnauthorized
	}
	a, err := s.repo.UserBySessionHash(ctx, HashToken(token))
	if err != nil || !a.ExpiresAt.After(s.now()) {
		return domain.Authenticated{}, ErrUnauthorized
	}
	return a, nil
}
func (s *Service) Logout(ctx context.Context, token string) error {
	if len(token) != 43 {
		return ErrUnauthorized
	}
	return s.repo.RevokeSession(ctx, HashToken(token))
}
func (s *Service) Folders(ctx context.Context, u domain.User) ([]domain.Folder, error) {
	return s.repo.ListVisibleFolders(ctx, u)
}
func (s *Service) Ready(ctx context.Context) error { return s.repo.Ping(ctx) }
