package ports

import "context"

// One real, signed trial Gate candidate can file at most one immutable formal
// Stage Gate review intake. This is NOT an accepted-stage transition port.
type DHFStageGateReviewStore interface {
	DHFPilotBeginSubmission(context.Context) error
	DHFStageGateProjectGraph(context.Context, string) ([]DHFStageGateGraphNode, error)
	DHFStageGateReviewSourceForSigner(context.Context, string, string) (DHFStageGateReviewSource, error)
	DHFStageGateReviewBySubmission(context.Context, string) (DHFStageGateReviewRecord, error)
	DHFStageGateObservedDependency(context.Context, string, string) (string, error)
	DHFStageGatePersistReview(context.Context, DHFStageGateReviewRecord) error
	DHFPilotRecentAttestationAuthFailures(context.Context, string) (int, error)
	DHFPilotAuditAttestationAuthFailure(context.Context, string, string) error
}

// Verified project-wide, explicit (never numerically inferred) G1-G9 graph.
type DHFStageGateGraphNode struct {
	StageID                 string                  `json:"stageId"`
	TemplateID              string                  `json:"templateId"`
	PolicySHA               string                  `json:"policySha"`
	PositionState           string                  `json:"positionState"`
	ConditionalTemplateFlag bool                    `json:"conditionalTemplateFlag"`
	Dependencies            []DHFStageGateGraphEdge `json:"dependencies"`
}
type DHFStageGateGraphEdge struct {
	ID               string `json:"id"`
	PredecessorStage string `json:"predecessorStage"`
	GuardedAction    string `json:"guardedAction"`
	AllowConditional bool   `json:"allowConditional"`
}

type DHFStageGateReviewSource struct {
	Candidate  DHFPilotGateCandidateRecord
	PolicyBody []byte
	Published  bool
}
type DHFStageGateDependency struct {
	ID               string `json:"id"`
	PredecessorStage string `json:"predecessorStage"`
	GuardedAction    string `json:"guardedAction"`
	State            string `json:"state"`
}
type DHFStageGateReviewRecord struct {
	ID                    string                   `json:"id"`
	SubmissionID          string                   `json:"submissionId"`
	CandidateID           string                   `json:"candidateId"`
	AttemptID             string                   `json:"attemptId"`
	ProjectID             string                   `json:"projectId"`
	StageID               string                   `json:"stageId"`
	TemplateID            string                   `json:"templateId"`
	SignerID              string                   `json:"signerId"`
	Mode                  string                   `json:"mode"`
	State                 string                   `json:"state"`
	PolicySHA             string                   `json:"policySha"`
	ManifestSHA           string                   `json:"manifestSha"`
	CandidatePayloadSHA   string                   `json:"candidatePayloadSha"`
	Dependencies          []DHFStageGateDependency `json:"dependencies"`
	MissingPreconditions  []string                 `json:"missingPreconditions"`
	IdempotencyKey        string                   `json:"-"`
	RequestSHA            string                   `json:"-"`
	DependencySnapshotSHA string                   `json:"dependencySnapshotSha"`
	ProjectGraph          []DHFStageGateGraphNode  `json:"projectGraph,omitempty"`
	ProjectGraphSHA       string                   `json:"projectGraphSha,omitempty"`
	TrialOnly             bool                     `json:"trialOnly"`
	FormalAccepted        bool                     `json:"formalAccepted"`
}
