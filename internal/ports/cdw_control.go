package ports

import "context"

// Candidate names are projections of immutable formal-approval facts, not
// ordinary file_versions.current_version_seq.
type CDWApprovedCandidate struct {
	ID         string `json:"id"`
	FileID     string `json:"fileId"`
	FileName   string `json:"fileName"`
	SHA256     string `json:"sha256"`
	ApprovedAt string `json:"approvedAt"`
}
type CDWControlledRelease struct {
	ID                 string  `json:"id"`
	FileID             string  `json:"fileId"`
	FileName           string  `json:"fileName"`
	CandidateID        string  `json:"candidateId"`
	RevisionLabel      string  `json:"revisionLabel"`
	SHA256             string  `json:"sha256"`
	State              string  `json:"state"`
	Revision           int64   `json:"revision"`
	PlannedEffectiveAt *string `json:"plannedEffectiveAt,omitempty"`
}
type CDWControlStore interface {
	CDWControlCandidates(context.Context, int) ([]CDWApprovedCandidate, error)
	CDWControlCandidateFile(context.Context, string) (string, error)
	CDWControlFile(context.Context, string) (string, error)
	CDWControlList(context.Context, string, int) ([]CDWControlledRelease, error)
	CDWControlRole(context.Context, string, string, string) (string, error)
	CDWControlGrantRole(context.Context, string, string, string, string) (string, error)
	CDWControlPrepare(context.Context, string, string, string, string, string, string, *string) (CDWControlledRelease, error)
	CDWControlVerify(context.Context, string, string, string, string, int64, string) (CDWControlledRelease, error)
	CDWControlIssue(context.Context, string, string, int64, string, string) (CDWControlledRelease, error)
	CDWControlEvent(context.Context, string, string, string, string, map[string]any) error
}
