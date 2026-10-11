package domain

import "time"

// Lifecycle metadata describes a released version; file_versions stays immutable.
type FileLifecycle struct {
	FileID       string     `json:"fileId"`
	State        string     `json:"state"`
	PublishedSeq int        `json:"publishedSeq"`
	PublishedAt  time.Time  `json:"publishedAt"`
	PublishedBy  string     `json:"publishedBy"`
	DueAt        *time.Time `json:"dueAt,omitempty"`
	Note         string     `json:"note"`
	UpdatedAt    time.Time  `json:"updatedAt"`
}
