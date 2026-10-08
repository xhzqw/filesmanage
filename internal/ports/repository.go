package ports

import (
	"context"
	"filesmanage/internal/domain"
	"time"
)

type Repository interface {
	Ping(context.Context) error
	UserByLogin(context.Context, string) (domain.User, string, error)
	UserBySessionHash(context.Context, string) (domain.Authenticated, error)
	InsertSession(context.Context, string, string, time.Time) error
	RevokeSession(context.Context, string) error
	ChangePassword(context.Context, string, string, string, string) error
	ListVisibleFolders(context.Context, domain.User) ([]domain.Folder, error)
}
