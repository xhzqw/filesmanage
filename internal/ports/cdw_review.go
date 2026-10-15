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
}
type CDWReviewDecisionResult struct {
	GateID        string `json:"gateId"`
	DeliveryID    string `json:"deliveryId"`
	TaskID        string `json:"taskId"`
	State         string `json:"state"`
	TaskState     string `json:"taskState"`
	Revision      int64  `json:"revision"`
	Round         int    `json:"round"`
	ReturnOrderID string `json:"returnOrderId,omitempty"`
}
type CDWResumeResult struct {
	TaskID   string `json:"taskId"`
	BranchID string `json:"branchId"`
	Revision int64  `json:"revision"`
	Round    int    `json:"round"`
	State    string `json:"state"`
}
type CDWReviewStore interface {
	CDWReviewInbox(context.Context, string, int) ([]CDWReviewGate, error)
	CDWReviewByID(context.Context, string) (CDWReviewGate, error)
	CDWReviewBlobSource(context.Context, string) (CDWBranchSource, error)
	CDWReviewEvent(context.Context, string, string, string, string, map[string]any) error
	CDWDecideReview(context.Context, string, string, int64, string, string, string, string) (CDWReviewDecisionResult, error) // gate/actor/revision/decision/reason/decisionID/returnOrderID
	CDWResumeReturned(context.Context, string, string, int64, string, string) (CDWResumeResult, error)                       // task/actor/expected/branchID/revisionID
}
