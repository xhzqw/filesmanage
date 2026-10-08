package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"golang.org/x/crypto/bcrypt"
	"testing"
	"time"
)

type memoryRepo struct {
	hash      string
	tokenHash string
	revoked   bool
	expires   time.Time
}

func (r *memoryRepo) Ping(context.Context) error { return nil }
func (r *memoryRepo) UserByLogin(_ context.Context, login string) (domain.User, string, error) {
	if login != "admin" {
		return domain.User{}, "", errors.New("not found")
	}
	return domain.User{ID: "u_admin", Login: "admin", DisplayName: "系统管理员", IsAdmin: true}, r.hash, nil
}
func (r *memoryRepo) InsertSession(_ context.Context, hash, user string, exp time.Time) error {
	if user != "u_admin" {
		return errors.New("wrong account")
	}
	r.tokenHash = hash
	r.expires = exp
	return nil
}
func (r *memoryRepo) UserBySessionHash(_ context.Context, hash string) (domain.Authenticated, error) {
	if r.revoked || r.tokenHash != hash {
		return domain.Authenticated{}, errors.New("missing")
	}
	return domain.Authenticated{User: domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}, ExpiresAt: r.expires}, nil
}
func (r *memoryRepo) RevokeSession(_ context.Context, hash string) error {
	if hash != r.tokenHash {
		return errors.New("missing")
	}
	r.revoked = true
	return nil
}
func (r *memoryRepo) ChangePassword(_ context.Context, userID, oldHash, newHash, keepSessionHash string) error {
	if userID != "u_admin" || oldHash != r.hash || keepSessionHash != r.tokenHash {
		return errors.New("credential precondition mismatch")
	}
	r.hash = newHash
	return nil
}
func (r *memoryRepo) ListVisibleFolders(_ context.Context, u domain.User) ([]domain.Folder, error) {
	if u.ID != "u_admin" {
		return nil, errors.New("not allowed")
	}
	return []domain.Folder{{ID: "folder_root", Name: "中晟生物科技"}}, nil
}
func TestLoginSessionLogout(t *testing.T) {
	pass := "long-unit-test-password"
	hash, err := bcrypt.GenerateFromPassword([]byte(pass), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	r := &memoryRepo{hash: string(hash)}
	fixed := time.Date(2026, 10, 8, 13, 0, 0, 0, time.UTC)
	s := New(r).WithClock(func() time.Time { return fixed })
	if _, _, err = s.Login(context.Background(), "admin", "wrong"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("wrong password should reject: %v", err)
	}
	token, u, err := s.Login(context.Background(), "admin", pass)
	if err != nil || len(token) != 43 || u.ID != "u_admin" {
		t.Fatalf("login failed: %v", err)
	}
	if r.tokenHash == token {
		t.Fatal("raw token persisted in repository")
	}
	a, err := s.Session(context.Background(), token)
	if err != nil || a.User.ID != "u_admin" {
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
}
func TestSessionExpiry(t *testing.T) {
	r := &memoryRepo{tokenHash: HashToken("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), expires: time.Date(2026, 10, 8, 13, 0, 0, 0, time.UTC)}
	s := New(r).WithClock(func() time.Time { return r.expires })
	if _, err := s.Session(context.Background(), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("expired session accepted")
	}
}
