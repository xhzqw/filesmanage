package ports

import (
	"context"
	"time"
)

type CDWEffectiveSearchJob struct {
	ReleaseID  string
	ArtifactID string
	BlobID     string
	SHA256     string
	FileName   string
	LeaseToken string
}
type CDWEffectiveSearchHit struct {
	FileID      string    `json:"fileId"`
	ReleaseID   string    `json:"releaseId"`
	FileName    string    `json:"fileName"`
	SHA256      string    `json:"sha256"`
	EffectiveAt time.Time `json:"effectiveAt"`
	Snippet     string    `json:"snippet"`
}

// This is the *bounded candidate* read. Application rechecks live generic
// file ACL and CDW release-specific preview authorization for each hit.
type CDWEffectiveSearchStore interface {
	CDWSearchEffectiveCandidates(context.Context, FileSearchQuery) ([]CDWEffectiveSearchHit, error)
}
type CDWEffectiveIndexJobs interface {
	CDWClaimEffectiveIndexJob(context.Context) (CDWEffectiveSearchJob, bool, error)
	CDWFinishEffectiveIndexJob(context.Context, CDWEffectiveSearchJob, string, string) error
	CDWRetryEffectiveIndexJob(context.Context, CDWEffectiveSearchJob) error
}
