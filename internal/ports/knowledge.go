package ports

import (
	"context"
	"encoding/json"
	"time"
)

// KnowledgePage is a standalone editable page. It is never a DHF/CDW
// signed or issued document. Revision is optimistic concurrency control.
type KnowledgePage struct {
	ID        string          `json:"id"`
	ParentID  *string         `json:"parentId"`
	FolderID  *string         `json:"folderId"`
	OwnerID   string          `json:"ownerId"`
	Title     string          `json:"title"`
	Blocks    json.RawMessage `json:"blocks"`
	Revision  int             `json:"revision"`
	UpdatedAt time.Time       `json:"updatedAt"`
}
type KnowledgeFileReference struct {
	FileID   string `json:"fileId"`
	FileName string `json:"fileName"`
	FolderID string `json:"folderId"`
}
type KnowledgeBacklink struct {
	PageID   string  `json:"pageId"`
	Title    string  `json:"title"`
	FolderID *string `json:"folderId"`
	OwnerID  string  `json:"ownerId"`
}
type KnowledgeVersion struct {
	Revision   int             `json:"revision"`
	Title      string          `json:"title"`
	Blocks     json.RawMessage `json:"blocks"`
	EditorID   string          `json:"editorId"`
	RecordedAt time.Time       `json:"recordedAt"`
}
type KnowledgePageLink struct {
	PageID    string  `json:"pageId"`
	Title     string  `json:"title"`
	FolderID  *string `json:"folderId"`
	OwnerID   string  `json:"ownerId"`
	Direction string  `json:"direction"`
}
type KnowledgeStore interface {
	KnowledgeList(context.Context, string) ([]KnowledgePage, error)
	KnowledgeByID(context.Context, string) (KnowledgePage, error)
	KnowledgeHistory(context.Context, string) ([]KnowledgeVersion, error)
	KnowledgePageLinks(context.Context, string) ([]KnowledgePageLink, error)
	KnowledgeLinkPage(context.Context, string, string, string) error
	KnowledgeUnlinkPage(context.Context, string, string) error
	KnowledgeCreate(context.Context, KnowledgePage) error
	KnowledgeUpdate(context.Context, KnowledgePage, int, string) (bool, error)
	KnowledgeDelete(context.Context, string, int) (bool, error)
	KnowledgeHome(context.Context, string) (string, error)
	KnowledgeLinkHome(context.Context, string, string, string) error
	KnowledgeUnlinkHome(context.Context, string) error
	KnowledgeFiles(context.Context, string) ([]KnowledgeFileReference, error)
	KnowledgeLinkFile(context.Context, string, string, string) error
	KnowledgeUnlinkFile(context.Context, string, string) error
	KnowledgeFileBacklinks(context.Context, string) ([]KnowledgeBacklink, error)
}
