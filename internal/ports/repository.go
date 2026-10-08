package ports

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"time"
)

// ErrRowMissing lets the application distinguish "not found" from real failures
// without importing a database driver.
var ErrRowMissing = errors.New("row missing")

// Repository is the persistence contract consumed by the application layer.
// Implementations may be pool-backed (reads) or transaction-backed (writes);
// every write use case runs inside one transaction that owns all of its stores.
type Repository interface {
	Ping(context.Context) error

	// Identity and sessions.
	UserByLogin(context.Context, string) (domain.User, string, error)
	UserBySessionHash(context.Context, string) (domain.Authenticated, error)
	InsertSession(context.Context, string, string, time.Time) error
	RevokeSession(context.Context, string) error
	ChangePassword(context.Context, string, string, string, string) error

	// Folders and visibility.
	ListVisibleFolders(context.Context, domain.User) ([]domain.Folder, error)
	FolderByID(context.Context, string) (domain.Folder, error)
	FolderParentMap(context.Context) (map[string]*string, error)
	CreateFolder(context.Context, domain.Folder) error
	RenameFolder(context.Context, string, string) error
	MoveFolder(context.Context, string, *string) error
	SoftDeleteFolder(context.Context, string) error
	RestoreFolder(context.Context, string) error
	SoftDeleteFilesUnderFolders(context.Context, []string) error
	RestoreFilesUnderFolders(context.Context, []string) error
	CountFilesInFolders(context.Context, []string) (int, error)
	FolderSubtree(context.Context, string) ([]domain.Folder, error)
	FolderSubtreeIncludingDeleted(context.Context, string) ([]domain.Folder, error)
	SubtreeFileCount(context.Context, string) (int, error)

	// Files, versions and blobs.
	ListFiles(context.Context, FileQuery) ([]domain.File, error)
	FileByID(context.Context, string) (domain.File, error)
	FileByNameInFolder(context.Context, string, string) (domain.File, error)
	RenameFile(context.Context, string, string) error
	CreateFileWithFirstVersion(context.Context, domain.File, domain.FileVersion) error
	InsertBlob(context.Context, domain.Blob) error
	HasActiveApprovalPolicy(context.Context, string) (bool, error)
	AppendVersion(context.Context, domain.FileVersion) error
	UpdateCurrentVersion(context.Context, string, int) error
	SetFileContentType(context.Context, string, string) error
	SoftDeleteFile(context.Context, string) error
	RestoreFile(context.Context, string) error
	NextVersionSeq(context.Context, string) (int, error)
	VersionsByFile(context.Context, string) ([]domain.FileVersion, error)
	VersionBySeq(context.Context, string, int) (domain.FileVersion, error)
	BlobBySha(context.Context, string) (domain.Blob, error)
	BlobByID(context.Context, string) (domain.Blob, error)
	SetBlobState(context.Context, string, string) error

	// Grants and subjects.
	WorkgroupsOf(context.Context, string) ([]string, error)
	UserExists(context.Context, string) (bool, error)
	WorkgroupExists(context.Context, string) (bool, error)
	EffectiveGrants(context.Context, string, string) ([]GrantAt, error)
	ListGrants(context.Context, string) ([]domain.ACL, error)
	GrantByID(context.Context, string) (domain.ACL, error)
	InsertGrant(context.Context, domain.ACL) error
	DeleteGrant(context.Context, string) error

	// Trash.
	InsertTrashEntry(context.Context, domain.TrashEntry) error
	ListTrashEntries(context.Context, string) ([]domain.TrashEntry, error)
	TrashEntryByID(context.Context, string) (domain.TrashEntry, error)
	MarkTrashRestored(context.Context, string) error
	MarkTrashPurged(context.Context, string) error

	// Audit and idempotency.
	RecordAudit(context.Context, domain.AuditEvent) error
	IdempotencyGet(context.Context, string, string, string) ([]byte, bool, error)
	IdempotencyPut(context.Context, string, string, string, []byte) error
}

// GrantAt is a grant together with its distance from the evaluated folder.
// Depth 0 is the folder itself; deeper grants are inherited from ancestors and
// must not honor scope_only.
type GrantAt struct {
	Grant domain.ACL
	Depth int
}

// FileQuery is the stable, cursor-paginated file list request. Cursor fields
// carry the sort key of the last row of the previous page.
type FileQuery struct {
	FolderID   string
	Sort       string
	CursorTime time.Time
	CursorID   string
	CursorName string
	CursorSize int64
	Limit      int
}

// UnitOfWork begins the single transaction a write use case runs in.
type UnitOfWork interface {
	Begin(context.Context) (Tx, error)
}

// Tx is a Repository bound to one transaction plus its commit control.
type Tx interface {
	Repository
	Commit(context.Context) error
	Rollback(context.Context) error
}
