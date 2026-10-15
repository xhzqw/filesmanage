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
	CDWDistributionDispatch(context.Context, string, string, string, int64, string, []string, []string, []string) (CDWDistributionBatch, error)
	CDWDistributionEvent(context.Context, string, string, string, string, any) error
}
