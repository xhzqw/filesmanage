package ports

import "context"

// A blocked decision is an audited outcome, not an activation or a success
// acknowledgement. Only the activated outcome advances effective state.
type CDWActivationDecision struct {
	ReleaseID       string   `json:"releaseId"`
	FileID          string   `json:"fileId"`
	Outcome         string   `json:"outcome"`
	Revision        int64    `json:"revision"`
	PointerRevision int64    `json:"pointerRevision"`
	PriorReleaseID  string   `json:"priorReleaseId,omitempty"`
	EffectiveAt     *string  `json:"effectiveAt,omitempty"`
	Blockers        []string `json:"blockers"`
}
type CDWActivationStore interface {
	CDWActivateRelease(context.Context, string, string, string, int64, string) (CDWActivationDecision, error)
}
