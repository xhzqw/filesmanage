package ports

import "context"

// No formal accepted or conditional grant execution is exposed here.
// Independently delegated persons may only append pilot return/reject
// recommendations; the original Gate applicant cannot review their own work.
type DHFGateDecisionReviewStore interface {
	DHFPilotBeginSubmission(context.Context) error
	DHFPilotRecentAttestationAuthFailures(context.Context, string) (int, error)
	DHFPilotAuditAttestationAuthFailure(context.Context, string, string) error
	DHFGateDecisionReviewInbox(context.Context, string) ([]DHFGateDecisionReviewItem, error)
	DHFGateDecisionReviewByID(context.Context, string, string) (DHFGateDecisionReviewItem, error)
	DHFGateDecisionReviewOpinionByReview(context.Context, string) (DHFGateDecisionReviewOpinion, error)
	DHFGateDecisionReviewPersistOpinion(context.Context, DHFGateDecisionReviewOpinion) error
}

type DHFGateDecisionReviewItem struct {
	ReviewID            string                        `json:"reviewId"`
	SubmissionID        string                        `json:"submissionId"`
	ProjectID           string                        `json:"projectId"`
	StageID             string                        `json:"stageId"`
	GateSignerID        string                        `json:"gateSignerId"`
	CandidateID         string                        `json:"candidateId"`
	CandidatePayloadSHA string                        `json:"candidatePayloadSha"`
	ProjectGraphSHA     string                        `json:"projectGraphSha"`
	GrantID             string                        `json:"-"`
	Opinion             *DHFGateDecisionReviewOpinion `json:"opinion,omitempty"`
	TrialOnly           bool                          `json:"trialOnly"`
	FormalAccepted      bool                          `json:"formalAccepted"`
}

type DHFGateDecisionReviewOpinion struct {
	ID                 string `json:"id"`
	ReviewID           string `json:"reviewId"`
	GrantID            string `json:"-"`
	ReviewerID         string `json:"reviewerId"`
	Opinion            string `json:"opinion"`
	Reason             string `json:"reason"`
	SourceGraphSHA     string `json:"sourceGraphSha"`
	SourceCandidateSHA string `json:"sourceCandidateSha"`
	IdempotencyKey     string `json:"-"`
	RequestSHA         string `json:"-"`
	TrialOnly          bool   `json:"trialOnly"`
	FormalAccepted     bool   `json:"formalAccepted"`
}
