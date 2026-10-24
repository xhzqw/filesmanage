package ports

import (
	"context"
	"filesmanage/internal/domain/dhf"
)

// DHFPilotSnapshotStore is implemented only by transaction-backed adapters.
// It is not embedded into Repository yet: the pilot is deliberately opt-in,
// so legacy mocks/workflows never acquire accidental Stage Gate authority.
// Read methods MUST share one repeatable-read, read-only transaction.
type DHFPilotSnapshotStore interface {
	DHFPilotBeginSnapshot(context.Context) error
	DHFPilotAttemptForActor(context.Context, string, string) (DHFPilotAttemptRecord, error)
	DHFPilotPredecessor(context.Context, string, string) (dhf.StageState, error)
}

// DHFPilotAttemptRecord consists of server-loaded database rows, not
// request-supplied GateInput. The policy/manifest hashes must be recomputed
// over the exact byte payloads by the application before evaluation.
type DHFPilotAttemptRecord struct {
	ProjectID          string
	StageID            string
	AttemptID          string
	TemplateVersionID  string
	PolicyBody         []byte
	PolicyHash         string
	PolicyStatus       string
	TemplateApproved   bool
	ManifestBody       []byte
	ManifestHash       string
	State              dhf.StageState
	ProjectState       string
	BaselineActive     bool
	CanPrepare         bool
	CanSubmit          bool
}

// DHFPilotVersionFact is an explicit file-version tuple referenced by a
// frozen DHF manifest. It is never inferred from the current/latest file.
type DHFPilotVersionFact struct {
	RequirementID string
	FileID        string
	Seq           int
	Sha256        string
}
