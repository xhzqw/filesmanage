package domain

import "time"

// Domain contains no HTTP, SQL, filesystem or infrastructure dependencies.
type User struct {
	ID, Login, DisplayName      string
	IsAdmin, MustChangePassword bool
}
type Folder struct {
	ID, Name string
	ParentID *string
}
type Authenticated struct {
	User      User
	ExpiresAt time.Time
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
