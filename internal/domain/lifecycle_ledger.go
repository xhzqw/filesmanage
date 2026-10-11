package domain

import "time"

type LifecycleLedgerRow struct {
	FileID         string     `json:"fileId"`
	FileName       string     `json:"fileName"`
	FolderID       string     `json:"folderId"`
	State          string     `json:"state"`
	PublishedSeq   int        `json:"publishedSeq"`
	ResponsibleName string   `json:"responsibleName"`
	DueAt          *time.Time `json:"dueAt,omitempty"`
	RetentionUntil *time.Time `json:"retentionUntil,omitempty"`
	DueStatus      string     `json:"dueStatus"`
}
type LifecycleNotification struct {
	ID        int64     `json:"id"`
	FileID    string    `json:"fileId"`
	FileName  string    `json:"fileName"`
	Kind      string    `json:"kind"`
	DueAt     time.Time `json:"dueAt"`
	CreatedAt time.Time `json:"createdAt"`
	Read      bool      `json:"read"`
}
