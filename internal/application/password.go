package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"golang.org/x/crypto/bcrypt"
)

var ErrPasswordPolicy = errors.New("password must be at least 16 characters")

func (s *Service) ChangePassword(ctx context.Context, sessionToken, oldPassword, newPassword string) (domain.User, error) {
	a, err := s.Session(ctx, sessionToken)
	if err != nil {
		return domain.User{}, ErrUnauthorized
	}
	if len(newPassword) < 16 || len(newPassword) > 128 {
		return domain.User{}, ErrPasswordPolicy
	}
	u, previousHash, err := s.repo.UserByLogin(ctx, a.User.Login)
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
	if err = s.repo.ChangePassword(ctx, u.ID, previousHash, string(newHash), HashToken(sessionToken)); err != nil {
		return domain.User{}, err
	}
	u.MustChangePassword = false
	return u, nil
}
