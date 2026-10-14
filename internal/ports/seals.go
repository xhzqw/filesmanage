package ports

import (
	"context"
	"filesmanage/internal/domain"
)

// SealStore is an optional capability of SQL-backed repositories; the core
// Repository is unchanged so historical test doubles stay independent.
type SealStore interface {
	ListSealUserPermissions(context.Context) ([]domain.SealUserPermission, error)
	SealUserPermission(context.Context, string) (domain.SealUserPermission, error)
	SetSealUserPermission(context.Context, string, bool, bool, string) error

	ListSeals(context.Context) ([]domain.SealAsset, error)
	GetSeal(context.Context, string) (domain.SealAsset, []byte, error)
	CreateSeal(context.Context, domain.SealAsset, []byte) error
	BindSeal(context.Context, string, string) error
	RetireSeal(context.Context, string) error
	RenameSeal(context.Context, string, string) error
	GrantSeal(context.Context, string, string, string) error
	RevokeSealGrant(context.Context, string, string) error
	HasSealGrant(context.Context, string, string) (bool, error)
	InsertSealMark(context.Context, domain.FileSealMark) error
	ListSealMarks(context.Context, string, int) ([]domain.FileSealMark, error)
	ListSealMarksAtRevision(context.Context, string, int, int) ([]domain.FileSealMark, error)
	ListSealRevisions(context.Context, string, int) ([]domain.SealRevision, error)
	SealRevision(context.Context, string, int, int) (domain.SealRevision, error)
	AppendSealRevision(context.Context, domain.SealRevision, int) error

	UsedSealAssetIDs(context.Context, string) ([]string, error)
	FileHasSeal(context.Context, string, string) (bool, error)
	GetSealMark(context.Context, string, string) (domain.FileSealMark, error)
}
