package domain

import "time"

// Share grants a subset of {list,preview,download} on one file or folder to a
// user or workgroup. Shares never confer write actions (SPEC §2.4).
type Share struct {
	ID                 string
	FileID             *string
	FolderID           *string
	RecipientKind      string
	RecipientID        string
	Actions            []Action
	IncludeDescendants bool
	ExpiresAt          *time.Time
	RevokedAt          *time.Time
	CreatedBy          string
	CreatedAt          time.Time
	ResourceName       string
	RecipientName      string
}

// Favorite is per-user metadata; deleted resources keep the row but show as
// unavailable instead of leaking details (SPEC §3.9).
type Favorite struct {
	ID           string
	UserID       string
	FileID       *string
	FolderID     *string
	CreatedAt    time.Time
	ResourceName string
	Unavailable  bool
}

// Stats is the aggregation result for the stats page and CSV export.
type Stats struct {
	TotalFiles   int64           `json:"totalFiles"`
	TotalFolders int64           `json:"totalFolders"`
	TotalBytes   int64           `json:"totalBytes"`
	Added30Days  int64           `json:"added30Days"`
	ByType       []TypeCount     `json:"byType"`
	ByMonth      []MonthCount    `json:"byMonth"`
	ByUploader   []UploaderCount `json:"byUploader"`
	ByFolder     []FolderCount   `json:"byFolder"`
}

// TypeCount groups files by extension bucket.
type TypeCount struct {
	Type  string `json:"type"`
	Count int64  `json:"count"`
	Bytes int64  `json:"bytes"`
}

// MonthCount groups new files per calendar month.
type MonthCount struct {
	Month string `json:"month"`
	Count int64  `json:"count"`
	Bytes int64  `json:"bytes"`
}

// UploaderCount groups new files per uploader.
type UploaderCount struct {
	UploaderID   string `json:"uploaderId"`
	UploaderName string `json:"uploaderName"`
	Count        int64  `json:"count"`
	Bytes        int64  `json:"bytes"`
}

// FolderCount contains direct-file totals for a visible folder.
type FolderCount struct {
	FolderID   string `json:"folderId"`
	FolderName string `json:"folderName"`
	Count      int64  `json:"count"`
	Bytes      int64  `json:"bytes"`
}
