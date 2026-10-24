package ports

import (
	"context"
	"time"
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


// DHFPilotSubmissionStore is implemented only by a WRITE transaction. It
// deliberately does not implement formal Gate approval or document issuance.
type DHFPilotSubmissionStore interface {
	DHFPilotSnapshotStore
	DHFPilotBeginSubmission(context.Context) error
	DHFPilotLockAttempt(context.Context,string) error
	DHFPilotSubmissionForAttempt(context.Context,string) (DHFPilotSubmissionRecord,error)
	DHFPilotPersistSubmission(context.Context,DHFPilotSubmissionRecord,[]DHFPilotEvidencePin,[]string) error
}

// DHFPilotEvidencePin binds one manifest requirement to the already verified
// immutable file-version/blob tuple, never the mutable current version.
type DHFPilotEvidencePin struct {
	RequirementID string
	FileID string
	VersionSeq int
	BlobID string
	Sha256 string
}

type DHFPilotSubmissionRecord struct {
	ID string
	AttemptID string
	ProjectID string
	StageID string
	TemplateID string
	SubmittedBy string
	IdempotencyKey string
	RequestSHA string
	PolicySHA string
	ManifestSHA string
}


// DHFPilotWorkbenchStore is a read-only assignment-scoped view for the
// existing Workbench. It never grants review or approval permissions.
type DHFPilotWorkbenchStore interface {
	DHFPilotSnapshotStore
	DHFPilotReviewTasksForActor(context.Context,string,int) ([]DHFPilotWorkbenchTask,error)
}

type DHFPilotWorkbenchTask struct {
	ID string `json:"id"`
	ProjectID string `json:"projectId"`
	StageID string `json:"stageId"`
	SubmissionID string `json:"submissionId"`
	ReviewKey string `json:"reviewKey"`
	Status string `json:"status"`
	AssignedAt time.Time `json:"assignedAt"`
}
