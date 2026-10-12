package domain

import "time"

// SealRevision is an immutable snapshot of the visible, version-anchored marks.
// Revision zero is the virtual unsigned source PDF and can always be restored.
type SealRevision struct {
	ID           string    `json:"id"`
	FileID       string    `json:"fileId"`
	VersionSeq   int       `json:"versionSeq"`
	Revision     int       `json:"revision"`
	MarkIDs      []string  `json:"-"`
	MarkCount    int       `json:"markCount"`
	Action       string    `json:"action"`
	ActorID      string    `json:"actorId"`
	ActorName    string    `json:"actorName"`
	RestoredFrom *int      `json:"restoredFrom,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
}
