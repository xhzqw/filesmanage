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
	Category          string
	Tag               string
	Uploader          string
	MimePrefix        string
	From              *time.Time
	To                *time.Time
	Sort              string
	// TextQuery is the CJK-spaced form of Query used against the tsvector
	// index (SPEC §10.2); Query itself still matches the file name.
	TextQuery string
	// The cursor fields carry the ordering keys of the active sort for the
	// last row of the previous page; an empty CursorID starts at page one.
	CursorTime time.Time
	CursorRank int
	CursorName string
	CursorID   string
	CursorSize int64
	// Limit is the repository row budget: search reads send their page size
	// plus one lookahead row so the caller can tell a full page from the last
	// one (WF-30); the repository accepts up to MaxSearchPage+1.
	Limit int
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

// ExportRow is one streamed CSV line. Fields follow SPEC §3.10: visible path,
// name, size, uploader, modification time, extension and current version.
// Blob paths and raw storage keys are never exported.
type ExportRow struct {
	FileID       string
	Path         string
	Name         string
	UploaderID   string
	UploaderName string
	SizeBytes    int64
	VersionSeq   int
	Extension    string
	UpdatedAt    time.Time
}

// CollaborationCursor is the stable descending keyset (created_at, id).
// A zero ID requests the first page; limit always includes the lookahead row.
type CollaborationCursor struct {
	CreatedAt time.Time
	ID        string
}

// CollaborationStore covers sharing, favorites, search, stats and export.
type CollaborationStore interface {
	ListSharesForSubject(context.Context, string, []string) ([]domain.Share, error)
	ListSharesCreatedBy(context.Context, string) ([]domain.Share, error)
	PageSharesForSubject(context.Context, string, []string, CollaborationCursor, int) ([]domain.Share, error)
	PageSharesCreatedBy(context.Context, string, CollaborationCursor, int) ([]domain.Share, error)
	ShareByID(context.Context, string) (domain.Share, error)
	CreateShare(context.Context, domain.Share) error
	RevokeShare(context.Context, string) error
	ListFavorites(context.Context, string) ([]domain.Favorite, error)
	PageFavorites(context.Context, string, CollaborationCursor, int) ([]domain.Favorite, error)
	FavoriteExists(context.Context, string, string, string) (bool, error)
	AddFavorite(context.Context, domain.Favorite) error
	RemoveFavorite(context.Context, string, string, string) error
	SearchFiles(context.Context, FileSearchQuery) ([]domain.File, int, error)
	Stats(context.Context, StatsQuery) (domain.Stats, error)
	// ExportFilesStream yields every authorized row for the filter without
	// materialising the result set (SPEC §3.10, READ-06, PE07): the export must
	// cover the whole filtered scope and stream with backpressure.
	ExportFilesStream(context.Context, StatsQuery, func(ExportRow) error) error
	// Share authorization reads used by the unified permission resolution
	// (SPEC §2.4): folder shares resolve along the ancestor chain, file shares
	// apply to the single shared file.
	FolderSharesForSubject(context.Context, string, []string, string) ([]domain.Share, error)
	FileSharesForSubject(context.Context, string, []string, string) ([]domain.Share, error)
	// Search index writes (SPEC §10.1).
	UpsertFileText(context.Context, string, int, string, string) error
	FileIDsMissingText(context.Context, int) ([]string, error)
}
