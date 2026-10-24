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
	GateReady bool `json:"gateReady"`
	AssignedAt time.Time `json:"assignedAt"`
}


// DHFPilotRecommendationStore persists a non-signing reviewer recommendation
// in a SERIALIZABLE tx. It cannot authorize a production DHF stage acceptance.
type DHFPilotRecommendationStore interface {
	DHFPilotBeginSubmission(context.Context) error
	DHFPilotReviewTaskForActor(context.Context,string,string) (DHFPilotRecommendationTask,error)
	DHFPilotRecommendationForTask(context.Context,string) (DHFPilotRecommendationRecord,error)
	DHFPilotPersistRecommendation(context.Context,DHFPilotRecommendationRecord) error
}

type DHFPilotRecommendationTask struct {
	ID string
	SubmissionID string
	ProjectID string
	StageID string
	ReviewKey string
	Status string
	ReviewerID string
	PolicySHA string
	ManifestSHA string
}

type DHFPilotRecommendationRecord struct {
	ID string
	TaskID string
	SubmissionID string
	ReviewerID string
	Outcome string
	Comment string
	IdempotencyKey string
	RequestSHA string
	PolicySHA string
	ManifestSHA string
}


// DHFPilotEvidenceStore reads pinned version tuples only for the task's
// current configured reviewer. Actual file ACL and physical digest checks
// MUST be applied in the application layer before exposing any file details.
type DHFPilotEvidenceStore interface {
	DHFPilotSnapshotStore
	DHFPilotEvidenceForReviewer(context.Context,string,string) ([]DHFPilotEvidencePin,error)
}


// DHFPilotRemediationStore is a write-transaction port. Return advice, new
// preparation attempt, opened-case journal and audit are one SERIALIZABLE unit.
// A remediation case cannot close a Gate or provide formal signature authority.
type DHFPilotRemediationStore interface {
 DHFPilotBeginSubmission(context.Context) error
 DHFPilotReturnedReviewForActor(context.Context,string,string) (DHFPilotReturnedReview,error)
 DHFPilotRemediationForReturn(context.Context,string) (DHFPilotRemediationRecord,error)
 DHFPilotPersistRemediation(context.Context,DHFPilotRemediationRecord,[]byte) error
}

type DHFPilotReturnedReview struct {
 DecisionID string
 OriginalSubmissionID string
 ProjectID string
 StageID string
 TemplateID string
 SubmittedBy string
 OriginalManifest []byte
 OriginalManifestSHA string
 PolicySHA string
}

type DHFPilotRemediationRecord struct {
 ID string
 ReturnDecisionID string
 OriginalSubmissionID string
 NewAttemptID string
 ProjectID string
 StageID string
 TemplateID string
 OpenedBy string
 ResolutionPlan string
 OriginalManifestSHA string
 RevisedManifestSHA string
 IdempotencyKey string
 RequestSHA string
}


// DHFPilotReturnInboxStore reads only return opinions from submissions whose
// original submitter is the currently authenticated user. This is not a
// privileged global review or an authorization to alter historic submissions.
type DHFPilotReturnInboxStore interface {
 DHFPilotBeginSnapshot(context.Context) error
 DHFPilotReturnsForAuthor(context.Context,string,int)([]DHFPilotReturnInboxRow,error)
}
type DHFPilotReturnInboxRow struct {
 DecisionID string
 ReviewKey string
 ProjectID string
 StageID string
 OriginalSubmissionID string
 OriginalManifest []byte
 OriginalManifestSHA string
 Reason string
 DecidedAt time.Time
 CaseID string
 NewAttemptID string
 NewAttemptState string
 CanPrepare bool
}


// DHFPilotEarlyInterventionStore never grants formal signature authority.
// It can only permit a later assigned SPECIALIST to record their own pilot
// review while all earlier responsibility obligations remain outstanding.
type DHFPilotEarlyInterventionStore interface {
 DHFPilotBeginSubmission(context.Context) error
 DHFPilotEarlyTargetForActor(context.Context,string,string)(DHFPilotEarlyTarget,error)
 DHFPilotEarlyInterventionForTarget(context.Context,string)(DHFPilotEarlyInterventionRecord,error)
 DHFPilotPersistEarlyIntervention(context.Context,DHFPilotEarlyInterventionRecord)error
}
type DHFPilotEarlyTarget struct{
 TaskID string
 SubmissionID string
 ReviewKey string
 StepOrdinal int
 PolicySHA string
 ManifestSHA string
}
type DHFPilotEarlyInterventionRecord struct {
 ID string
 TargetTaskID string
 SubmissionID string
 AuthorizedBy string
 Reason string
 IdempotencyKey string
 RequestSHA string
 PolicySHA string
 ManifestSHA string
}

// DHFPilotDutyReadStore surfaces immutable responsibility obligations and
// whether an early intervention was recorded; "reviewed" means trial review,
// not an authorized enterprise electronic signature or released Stage Gate.
type DHFPilotDutyReadStore interface {
 DHFPilotBeginSnapshot(context.Context) error
 DHFPilotDutiesForActor(context.Context,string,int)([]DHFPilotDutySnapshot,error)
}
type DHFPilotDutySnapshot struct {
 SubmissionID string `json:"submissionId"`
 ProjectID string `json:"projectId"`
 StageID string `json:"stageId"`
 TaskID string `json:"taskId"`
 ReviewKey string `json:"reviewKey"`
 StepOrdinal int `json:"stepOrdinal"`
 ReviewerID string `json:"reviewerId"`
 Status string `json:"status"`
 EarlyIntervention bool `json:"earlyIntervention"`
 InterventionReason string `json:"interventionReason,omitempty"`
 OutstandingPrior int `json:"outstandingPrior"`
 CanAuthorizeEarly bool `json:"canAuthorizeEarly"`
}


// DHFPilotAttestationStore is intentionally separate from file seals and
// non-signing recommendations. Authentication occurs anew inside the same
// SERIALIZABLE transaction and no password/password hash is persisted.
type DHFPilotAttestationStore interface {
 DHFPilotBeginSubmission(context.Context) error
 DHFPilotAttestationDecisionForSigner(context.Context,string,string)(DHFPilotAttestationDecision,error)
 DHFPilotAttestationForTask(context.Context,string)(DHFPilotAttestationRecord,error)
 DHFPilotPersistAttestation(context.Context,DHFPilotAttestationRecord) error
 DHFPilotRecentAttestationAuthFailures(context.Context,string)(int,error)
 DHFPilotAuditAttestationAuthFailure(context.Context,string,string) error
}
type DHFPilotAttestationDecision struct {
 DecisionID string
 TaskID string
 SubmissionID string
 ReviewerID string
 Outcome string
 Comment string
 PolicySHA string
 ManifestSHA string
}
type DHFPilotAttestationRecord struct {
 ID string
 ReviewDecisionID string
 TaskID string
 SubmissionID string
 SignerID string
 Outcome string
 SignIntent string
 PolicySHA string
 ManifestSHA string
 ContentSHA string
 IdempotencyKey string
 RequestSHA string
}


// Viewer scope is always the original assigned reviewer, never all project
// members, admins, or consumers of a recommendation copied via a task ID.
type DHFPilotAttestationInboxStore interface{
 DHFPilotBeginSnapshot(context.Context) error
 DHFPilotAttestationInboxForSigner(context.Context,string,int)([]DHFPilotAttestationInboxRow,error)
}
type DHFPilotAttestationInboxRow struct{
 TaskID string `json:"taskId"`
 DecisionID string `json:"decisionId"`
 SubmissionID string `json:"submissionId"`
 ProjectID string `json:"projectId"`
 StageID string `json:"stageId"`
 ReviewKey string `json:"reviewKey"`
 Outcome string `json:"outcome"`
 ReviewComment string `json:"reviewComment"`
 PolicySHA string `json:"policySha"`
 ManifestSHA string `json:"manifestSha"`
 OutstandingPrior int `json:"outstandingPrior"`
 CanAttest bool `json:"canAttest"`
 AttestationID string `json:"attestationId,omitempty"`
 ContentSHA string `json:"contentSha,omitempty"`
}
