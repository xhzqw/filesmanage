package ports

import (
	"context"
	"time"
)

// The signer-scoped historical read never grants authorization to sign.
// The repository, not the HTTP caller, resolves the original candidate.
type DHFPilotGateHistoryStore interface {
	DHFPilotBeginSnapshot(context.Context) error
	DHFPilotGateHistoryForSigner(context.Context, string, string) (DHFPilotGateHistory, error)
}

type DHFPilotGateHistory struct {
	SubmissionID        string
	ProjectID           string
	StageID             string
	TotalDuties         int
	SignedPassedDuties  int
	OpenRemediations    int
	CredentialStatus    string
	CredentialExpiresAt *time.Time
	Candidate           *DHFPilotGateCandidateRecord
}
