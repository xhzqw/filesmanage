package ports

import "context"

type CDWDistributionTargetInput struct {
	DepartmentID string `json:"departmentId"`
	ReceiverID   string `json:"receiverId"`
}
type CDWDistributionPlan struct {
	ID              string                       `json:"id"`
	ReleaseID       string                       `json:"releaseId"`
	FileID          string                       `json:"fileId"`
	FileName        string                       `json:"fileName"`
	State           string                       `json:"state"`
	Revision        int64                        `json:"revision"`
	DigestSHA256    string                       `json:"digestSha256,omitempty"`
	DepartmentCount int                          `json:"departmentCount"`
	Targets         []CDWDistributionTargetInput `json:"targets"`
}
type CDWDistributionItemSnapshot struct {
	Ordinal    int
	ReleaseID  string
	ArtifactID string
	SHA256     string
	Required   bool
}
type CDWDistributionTargetSnapshot struct {
	DepartmentID           string
	ReceiverID             string
	Channel                string
	PaperQuantity          int
	ReceiptRequired        bool
	ReadingRequired        bool
	ImplementationRequired bool
}
type CDWDistributionScopeSnapshot struct {
	PlanID   string
	FileID   string
	State    string
	Revision int64
	Items    []CDWDistributionItemSnapshot
	Targets  []CDWDistributionTargetSnapshot
}
type CDWDistributionBatch struct {
	ID              string `json:"id"`
	PlanID          string `json:"planId"`
	ReleaseID       string `json:"releaseId"`
	FileID          string `json:"fileId"`
	State           string `json:"state"`
	Revision        int64  `json:"revision"`
	DigestSHA256    string `json:"digestSha256"`
	DepartmentCount int    `json:"departmentCount"`
}
type CDWDistributionWithdrawal struct {
	ID                 string `json:"id"`
	BatchID            string `json:"batchId"`
	PlanID             string `json:"planId"`
	ReleaseID          string `json:"releaseId"`
	FileID             string `json:"fileId"`
	State              string `json:"state"`
	PlanRevision       int64  `json:"planRevision"`
	ManifestSHA256     string `json:"manifestSha256"`
	RevokedGrants      int64  `json:"revokedGrants"`
	CancelledReaders   int64  `json:"cancelledReaders"`
	InvalidatedTargets int64  `json:"invalidatedTargets"`
	ActorID            string `json:"actorId"`
	Reason             string `json:"reason"`
}
type CDWDistributionLedgerRow struct {
	TargetID         string  `json:"targetId"`
	DepartmentID     string  `json:"departmentId"`
	DepartmentName   string  `json:"departmentName"`
	ReceiverID       string  `json:"receiverId"`
	ReceiverName     string  `json:"receiverName"`
	ActualSignerID   *string `json:"actualSignerId,omitempty"`
	ActualSignerName *string `json:"actualSignerName,omitempty"`
	SignedAt         *string `json:"signedAt,omitempty"`
	ReceiptID        *string `json:"receiptId,omitempty"`
	ReceiptStatus    string  `json:"receiptStatus"`
	ReadingAssigned  int     `json:"readingAssigned"`
	ReadingConfirmed int     `json:"readingConfirmed"`
	ReadingStatus    string  `json:"readingStatus"`
	DueAt            *string `json:"dueAt,omitempty"`
	Overdue          bool    `json:"overdue"`
	ExceptionReason  *string `json:"exceptionReason,omitempty"`
}
type CDWDistributionLedger struct {
	PlanID           string                     `json:"planId"`
	BatchID          string                     `json:"batchId"`
	BatchState       string                     `json:"batchState"`
	ManifestSHA256   string                     `json:"manifestSha256"`
	Rows             []CDWDistributionLedgerRow `json:"rows"`
	ReceiptCompleted int                        `json:"receiptCompleted"`
	ReadingAssigned  int                        `json:"readingAssigned"`
	ReadingConfirmed int                        `json:"readingConfirmed"`
}
type CDWDistributionStore interface {
	CDWDistributionReleaseFile(context.Context, string) (string, error)
	CDWDistributionPlanFile(context.Context, string) (string, error)
	CDWDistributionCreate(context.Context, string, string, string, []CDWDistributionTargetInput) (CDWDistributionPlan, error)
	CDWDistributionSnapshot(context.Context, string) (CDWDistributionScopeSnapshot, error)
	CDWDistributionFreeze(context.Context, string, string, int64, string) (CDWDistributionPlan, error)
	CDWDistributionForRelease(context.Context, string) (CDWDistributionPlan, error)
	CDWDistributionRead(context.Context, string) (CDWDistributionPlan, error)
	CDWDistributionGrantScopeRole(context.Context, string, string, string, string) (string, error)
	CDWDistributionScopeApprove(context.Context, string, string, string, int64, string) (CDWDistributionPlan, error)
	CDWDistributionScopeInbox(context.Context, string, int) ([]CDWDistributionPlan, error)
	CDWDistributionDispatch(context.Context, string, string, string, int64, string, []string, []string, []string, []string) (CDWDistributionBatch, error)
	CDWDistributionLedger(context.Context, string) (CDWDistributionLedger, error)
	CDWDistributionWithdraw(context.Context, string, string, string, int64, string) (CDWDistributionWithdrawal, error)
	CDWDistributionEvent(context.Context, string, string, string, string, any) error
}
