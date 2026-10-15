package ports

import "context"

type CDWReviewGate struct {
	ID               string `json:"gateId"`
	DeliveryID       string `json:"deliveryId"`
	TaskID           string `json:"taskId"`
	TaskTitle        string `json:"taskTitle"`
	FileID           string `json:"fileId"`
	SubmittedBy      string `json:"submittedBy"`
	ReviewerID       string `json:"reviewerId"`
	BranchRevisionID string `json:"branchRevisionId"`
	SHA256           string `json:"sha256"`
	State            string `json:"state"`
	Revision         int64  `json:"revision"`
	Round            int    `json:"round"`
	Substitutable    bool   `json:"substitutable"`
	OverrideGrantID  string `json:"overrideGrantId,omitempty"`
	ReviewMode       string `json:"reviewMode"`
}
type CDWReviewDecisionResult struct {
	GateID          string `json:"gateId"`
	DeliveryID      string `json:"deliveryId"`
	TaskID          string `json:"taskId"`
	State           string `json:"state"`
	TaskState       string `json:"taskState"`
	Revision        int64  `json:"revision"`
	Round           int    `json:"round"`
	ReturnOrderID   string `json:"returnOrderId,omitempty"`
	ActingForID     string `json:"actingForId,omitempty"`
	OverrideGrantID string `json:"overrideGrantId,omitempty"`
}
type CDWResumeResult struct {
	TaskID   string `json:"taskId"`
	BranchID string `json:"branchId"`
	Revision int64  `json:"revision"`
	Round    int    `json:"round"`
	State    string `json:"state"`
}
type CDWReviewCandidate struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}
type CDWOverrideGrant struct {
	ID        string `json:"grantId"`
	GateID    string `json:"gateId"`
	TaskID    string `json:"taskId"`
	GrantedBy string `json:"grantedBy"`
	ActorID   string `json:"actorId"`
	ExpiresAt string `json:"expiresAt"`
	Revoked   bool   `json:"revoked"`
}
type CDWReviewStore interface {
	CDWReviewAccess(context.Context, string, string) (string, error)
	CDWGrantReview(context.Context, string, string, string, int64, string, string) (CDWOverrideGrant, error)
	CDWRevokeReviewGrant(context.Context, string, string, string) (CDWOverrideGrant, error)
	CDWReviewGrants(context.Context, string) ([]CDWOverrideGrant, error)
	CDWReviewCandidates(context.Context, string) ([]CDWReviewCandidate, error)
	CDWReviewInbox(context.Context, string, int) ([]CDWReviewGate, error)
	CDWReviewByID(context.Context, string) (CDWReviewGate, error)
	CDWReviewBlobSource(context.Context, string) (CDWBranchSource, error)
	CDWReviewEvent(context.Context, string, string, string, string, map[string]any) error
	CDWDecideReview(context.Context, string, string, int64, string, string, string, string, string) (CDWReviewDecisionResult, error) // gate/actor/revision/decision/reason/decisionID/returnOrderID
	CDWResumeReturned(context.Context, string, string, int64, string, string) (CDWResumeResult, error)                               // task/actor/expected/branchID/revisionID
}
