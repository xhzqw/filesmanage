package domain

import "time"

// Domain contains no HTTP, SQL, filesystem or infrastructure dependencies.

type User struct {
	ID, Login, DisplayName      string
	IsAdmin, MustChangePassword bool
	DepartmentID                string
	DisabledAt                  *time.Time
}

type Folder struct {
	ID, Name  string
	ParentID  *string
	OwnerID   string
	DeletedAt *time.Time
}

type File struct {
	ID, FolderID, Name string
	UploadedBy         string
	ContentType        string
	CurrentVersionSeq  *int
	SizeBytes          int64
	Sha256             string
	UpdatedAt          time.Time
	DeletedAt          *time.Time
	// Snippet is a search projection only (SPEC §10.3): a bounded plain-text
	// window around the match, rendered with safe text nodes plus <mark>.
	Snippet string
}

type FileVersion struct {
	ID, FileID               string
	Seq                      int
	BlobID, Sha256           string
	SizeBytes                int64
	Action                   string
	BaseSeq                  *int
	RollbackTargetSeq        *int
	RollbackFromSeq          *int
	Reason                   string
	CreatedBy, CreatedByName string
	CreatedAt                time.Time
}

type Blob struct {
	ID, StorageKey, Sha256 string
	SizeBytes              int64
	State                  string
}

type ACL struct {
	ID, FolderID             string
	SubjectKind, SubjectID   string
	Actions                  []Action
	ScopeOnly                bool
	ExpiresAt                *time.Time
	GrantedBy, GrantedByName string
}

type TrashEntry struct {
	ID           string
	FileID       *string
	FolderID     *string
	OldParentID  *string
	OldName      string
	DeletedBy    string
	DeletedName  string
	DeletedAt    time.Time
	RestoredAt   *time.Time
	PurgedAt     *time.Time
	SubtreeCount int
}

type AuditEvent struct {
	ActorID    string
	EventType  string
	TargetKind string
	TargetID   string
	RequestID  string
	Outcome    string
	Details    map[string]any
}

// PermissionAuditRecord is the bounded admin-only access change projection.
type PermissionAuditRecord struct {
	ID         int64          `json:"id"`
	ActorID    string         `json:"actorId"`
	RequestID  string         `json:"requestId"`
	EventType  string         `json:"eventType"`
	TargetKind string         `json:"targetKind"`
	TargetID   string         `json:"targetId"`
	Outcome    string         `json:"outcome"`
	Details    map[string]any `json:"details"`
	CreatedAt  time.Time      `json:"createdAt"`
}

type Action string

const (
	ActionList     Action = "list"
	ActionPreview  Action = "preview"
	ActionUpload   Action = "upload"
	ActionDownload Action = "download"
	ActionModify   Action = "modify"
	ActionDelete   Action = "delete"
	ActionRename   Action = "rename"
	ActionMove     Action = "move"
	ActionPrint    Action = "print"
)

func AllowedAction(a Action) bool {
	switch a {
	case ActionList, ActionPreview, ActionUpload, ActionDownload, ActionModify,
		ActionDelete, ActionRename, ActionMove, ActionPrint:
		return true
	default:
		return false
	}
}

// Version actions recorded on immutable signed versions.
const (
	VersionActionUpload   = "upload"
	VersionActionEdit     = "edit"
	VersionActionRollback = "rollback"
	VersionActionRestore  = "restore"
)

func AllowedVersionAction(a string) bool {
	switch a {
	case VersionActionUpload, VersionActionEdit, VersionActionRollback, VersionActionRestore:
		return true
	default:
		return false
	}
}

// Authenticated pairs the resolved user with session expiry.
type Authenticated struct {
	User      User
	ExpiresAt time.Time
}
