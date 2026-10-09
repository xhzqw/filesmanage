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
	ListVisibleFolderChildren(context.Context, FolderChildQuery) ([]FolderPageRow, error)
	SearchVisibleFolders(context.Context, FolderSearchQuery) ([]FolderPageRow, error)
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
	MoveFile(context.Context, string, string) error
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
	// P2: management role bindings are never file ACL grants.
	ListRoleBindings(context.Context) ([]domain.ManagementRoleBinding, error)
	RoleBindingsForUser(context.Context, string) ([]domain.ManagementRoleBinding, error)
	RoleBindingByID(context.Context, string) (domain.ManagementRoleBinding, error)
	InsertRoleBinding(context.Context, domain.ManagementRoleBinding) error
	RevokeRoleBinding(context.Context, string) error

	// Trash.
	InsertTrashEntry(context.Context, domain.TrashEntry) error
	ListTrashEntries(context.Context, string) ([]domain.TrashEntry, error)
	TrashEntryByID(context.Context, string) (domain.TrashEntry, error)
	MarkTrashRestored(context.Context, string) error
	MarkTrashPurged(context.Context, string) error

	// Organization (admin-managed identity data).
	ListUsers(context.Context) ([]domain.User, error)
	PageUsers(context.Context, string, int) ([]domain.User, error)
	UserByID(context.Context, string) (domain.User, error)
	CreateUser(context.Context, domain.User, string) error
	SetUserPassword(context.Context, string, string) error
	SetUserDepartment(context.Context, string, *string) error
	SetUserDisabled(context.Context, string, bool) error
	ForcePasswordChange(context.Context, string) error
	ListDepartments(context.Context) ([]domain.Department, error)
	CreateDepartment(context.Context, domain.Department) error
	RenameDepartment(context.Context, string, string) error
	ListWorkgroups(context.Context) ([]domain.Workgroup, error)
	PageWorkgroups(context.Context, string, int) ([]domain.Workgroup, error)
	WorkgroupByID(context.Context, string) (domain.Workgroup, error)
	CreateWorkgroup(context.Context, domain.Workgroup) error
	RenameWorkgroup(context.Context, string, string) error
	WorkgroupMembers(context.Context, string) ([]domain.User, error)
	AddWorkgroupMember(context.Context, string, string) error
	RemoveWorkgroupMember(context.Context, string, string) error

	// Approval policies, approvals and edit locks.
	ApprovalPolicyFor(context.Context, string) (domain.ApprovalPolicy, bool, error)
	UpsertApprovalPolicy(context.Context, domain.ApprovalPolicy) error
	ClearApprovalPolicy(context.Context, string) error
	CreateApproval(context.Context, domain.Approval) error
	ApprovalByID(context.Context, string) (domain.Approval, error)
	ListApprovalsForApprover(context.Context, string) ([]domain.Approval, error)
	ListApprovalsByRequester(context.Context, string) ([]domain.Approval, error)
	PendingApprovalForFile(context.Context, string) (domain.Approval, bool, error)
	DecideApproval(context.Context, string, string, string) (bool, error)
	LockByFileID(context.Context, string) (domain.EditLock, error)
	// LockFileRow takes the file's row lock inside the caller's transaction so
	// concurrent lock mutations on one file serialise instead of racing
	// (SPEC §7.2: acquire runs under a row lock, not an application mutex).
	LockFileRow(context.Context, string) error
	InsertLock(context.Context, domain.EditLock) error
	RenewLock(context.Context, string, string, time.Time, int64) (bool, error)
	ReleaseLock(context.Context, string, string) (bool, error)
	ForceReleaseLock(context.Context, string) (domain.EditLock, error)

	// Document editor sessions and save events.
	CreateOfficeSession(context.Context, domain.OfficeSession) error
	OfficeSessionByID(context.Context, string) (domain.OfficeSession, error)
	OfficeSessionByKey(context.Context, string) (domain.OfficeSession, error)
	ActiveOfficeSessionForFile(context.Context, string) (domain.OfficeSession, bool, error)
	SetOfficeSessionState(context.Context, string, string) error
	BumpOfficeSessionGeneration(context.Context, string) (int64, error)
	TouchOfficeSession(context.Context, string, time.Time) error
	CloseOfficeSession(context.Context, string) error
	SaveEventExists(context.Context, string, string) (bool, error)
	RecordSaveEvent(context.Context, domain.OfficeSaveEvent) error
	RecordCompatibilityReport(context.Context, domain.OfficeCompatibilityReport) error

	// CAD derivatives and worker jobs.
	EnsureDerivative(context.Context, domain.ModelDerivative) (domain.ModelDerivative, error)
	EnqueueDerivativeJob(context.Context, string, string) error
	ClaimDerivativeJob(context.Context) (domain.DerivativeJob, bool, error)
	CompleteDerivativeJob(context.Context, string) error
	FailDerivativeJob(context.Context, string, string) error
	MarkDerivativeNative(context.Context, string, string) error
	StoreDerivativeBlob(context.Context, string, string, string, string, int64) error
	DerivativeForFile(context.Context, string, int) (domain.ModelDerivative, bool, error)
	SourceBlobPath(context.Context, string) (string, error)

	// Collaboration: shares, favorites, search, stats and export.
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
	ExportFilesStream(context.Context, StatsQuery, func(ExportRow) error) error
	FolderSharesForSubject(context.Context, string, []string, string) ([]domain.Share, error)
	FileSharesForSubject(context.Context, string, []string, string) ([]domain.Share, error)
	UpsertFileText(context.Context, string, int, string, string) error
	FileIDsMissingText(context.Context, int) ([]string, error)

	// Audit and idempotency.
	RecordAudit(context.Context, domain.AuditEvent) error
	ListPermissionAudit(context.Context, int64, int) ([]domain.PermissionAuditRecord, error)
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

// MaxFilePage is the largest page a client may request from the file list.
// ListFiles asks the repository for one lookahead row beyond the page to
// detect a next page, so the repository accepts MaxFilePage+1.
const MaxFilePage = 200

// MaxFolderPage is the largest page a client may request from the paged folder
// reads (children/search). The service asks for one lookahead row beyond the
// page to detect a next page, so the repository accepts MaxFolderPage+1.
const MaxFolderPage = 200

// MaxSearchPage is the largest page a client may request from the file search
// (GET /api/search). The service asks for one lookahead row beyond the page to
// detect a next page, so the repository accepts MaxSearchPage+1.
const MaxSearchPage = 200

// FolderChildQuery is the keyset-paginated children read behind
// GET /api/folders/children. ParentID "" addresses the caller's visible roots,
// which include a listable folder whose parent the caller may not list (a pruned
// subtree surfaces as an accessible root). Cursor fields carry the sort key
// (name, id) of the last row of the previous page.
type FolderChildQuery struct {
	UserID     string
	ParentID   string
	CursorName string
	CursorID   string
	Limit      int
}

// FolderSearchQuery is the keyset-paginated name search behind
// GET /api/folders/search, scoped to folders the caller may list. Query is the
// already-validated name fragment; the cursor follows the same (name, id) key as
// FolderChildQuery.
type FolderSearchQuery struct {
	UserID     string
	Query      string
	CursorName string
	CursorID   string
	Limit      int
}

// FolderPageRow is one visible folder plus the read hints the FolderPicker
// renders. HasChildren is probed with an EXISTS over the caller's visible
// children, so a page never loads the children it only has to count.
type FolderPageRow struct {
	Folder      domain.Folder
	HasChildren bool
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
