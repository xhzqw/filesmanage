package ports

import (
	"context"
	"filesmanage/internal/domain"
	"time"
)

// FileSearchQuery is the shared list/search/stats/export filter. Every read
// feature reuses one visibility scope (SPEC READ-01).
type FileSearchQuery struct {
	UserID            string
	GroupIDs          []string
	FolderID          string
	IncludeDescendant bool
	Query             string
	Uploader          string
	MimePrefix        string
	From              *time.Time
	To                *time.Time
	Sort              string
	CursorTime        time.Time
	CursorName        string
	CursorID          string
	Limit             int
}

// StatsQuery is the aggregation filter over the same visibility scope.
type StatsQuery struct {
	UserID            string
	GroupIDs          []string
	FolderID          string
	IncludeDescendant bool
	Uploader          string
	MimePrefix        string
	From              *time.Time
	To                *time.Time
}

// CollaborationStore covers sharing, favorites, search, stats and export.
type CollaborationStore interface {
	ListSharesForSubject(context.Context, string, []string) ([]domain.Share, error)
	ListSharesCreatedBy(context.Context, string) ([]domain.Share, error)
	ShareByID(context.Context, string) (domain.Share, error)
	CreateShare(context.Context, domain.Share) error
	RevokeShare(context.Context, string) error
	ListFavorites(context.Context, string) ([]domain.Favorite, error)
	FavoriteExists(context.Context, string, string, string) (bool, error)
	AddFavorite(context.Context, domain.Favorite) error
	RemoveFavorite(context.Context, string, string, string) error
	SearchFiles(context.Context, FileSearchQuery) ([]domain.File, int, error)
	Stats(context.Context, StatsQuery) (domain.Stats, error)
	ExportFiles(context.Context, StatsQuery, int) ([]domain.File, error)
}
