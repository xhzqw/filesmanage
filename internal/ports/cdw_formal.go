package ports

import (
	"context"
	"time"
)

// Equal sequence numbers are a parallel, unanimous approval group.
type CDWFormalStepDefinition struct {
	NodeKey    string `json:"nodeKey"`
	Sequence   int    `json:"sequence"`
	ApproverID string `json:"approverId"`
}
type CDWFormalApproval struct {
	ID                string `json:"id"`
	SubjectID         string `json:"subjectId"`
	DeliveryID        string `json:"deliveryId"`
	FileID            string `json:"fileId"`
	FileName          string `json:"fileName,omitempty"`
	SHA256            string `json:"sha256"`
	TemplateVersionID string `json:"templateVersionId"`
	State             string `json:"state"`
	Revision          int64  `json:"revision"`
	CandidateID       string `json:"candidateId,omitempty"`
	RequestedBy       string `json:"requestedBy"`
}
type CDWFormalStep struct {
	ID         string `json:"id"`
	NodeKey    string `json:"nodeKey"`
	Sequence   int    `json:"sequence"`
	ApproverID string `json:"approverId"`
	State      string `json:"state"`
	Revision   int64  `json:"revision"`
}
type CDWFormalDecision struct {
	StepID    string `json:"stepId"`
	ActorID   string `json:"actorId"`
	Decision  string `json:"decision"`
	Reason    string `json:"reason"`
	DecidedAt string `json:"decidedAt"`
}
type CDWFormalDetail struct {
	Approval  CDWFormalApproval   `json:"approval"`
	Steps     []CDWFormalStep     `json:"steps"`
	Decisions []CDWFormalDecision `json:"decisions"`
}

type CDWFormalReadyDelivery struct {
	DeliveryID string `json:"deliveryId"`
	TaskID     string `json:"taskId"`
	FileID     string `json:"fileId"`
	FileName   string `json:"fileName"`
	SHA256     string `json:"sha256"`
}

type CDWDocumentClassification struct {
	FileID        string `json:"fileId"`
	ApprovalClass string `json:"approvalClass"`
	RequiresQMS   bool   `json:"requiresQms"`
	Reason        string `json:"reason,omitempty"`
	ClassifiedBy  string `json:"classifiedBy,omitempty"`
	RoleBindingID string `json:"roleBindingId,omitempty"`
}

type CDWQMSAppointment struct {
	ID                string `json:"id"`
	FileID            string `json:"fileId"`
	UserID            string `json:"userId"`
	NodeKey           string `json:"nodeKey"`
	PolicyReleaseID   string `json:"policyReleaseId"`
	EvidenceReleaseID string `json:"evidenceReleaseId"`
	ExpiresAt         string `json:"expiresAt"`
	Status            string `json:"status"`
	ProposedBy        string `json:"proposedBy"`
	VerifiedBy        string `json:"verifiedBy,omitempty"`
	Reason            string `json:"reason"`
}
type CDWQMSPendingReview struct {
	CDWQMSAppointment
	FileName         string `json:"fileName"`
	EvidenceFileID   string `json:"evidenceFileId"`
	EvidenceFileName string `json:"evidenceFileName"`
}
type CDWQMSAppointmentAlert struct {
	ID            string  `json:"id"`
	AppointmentID string  `json:"appointmentId"`
	FileID        string  `json:"fileId"`
	NodeKey       string  `json:"nodeKey"`
	CreatedAt     string  `json:"createdAt"`
	ReadAt        *string `json:"readAt,omitempty"`
}
type CDWQMSAppointmentEvidenceSource struct {
	CDWBranchSource
	SHA256    string
	ReleaseID string
}

// All mutations run inside the caller's UnitOfWork transaction.
type CDWFormalStore interface {
	CDWQMSRevokeAppointment(context.Context, string, string, string) (CDWQMSAppointment, error)
	CDWQMSAppointmentAlerts(context.Context, string, int) ([]CDWQMSAppointmentAlert, error)
	CDWQMSReadAppointmentAlert(context.Context, string, string) (bool, error)
	CDWQMSAppointmentEvidenceSource(context.Context, string) (CDWQMSAppointmentEvidenceSource, error)
	CDWQMSProposeAppointment(context.Context, string, string, string, string, string, string, string, time.Time, string) (CDWQMSAppointment, error)
	CDWQMSVerifyAppointment(context.Context, string, string, string) (CDWQMSAppointment, error)
	CDWQMSAppointmentFile(context.Context, string) (string, error)
	CDWQMSAppointmentSourceFiles(context.Context, string) (string, string, error)
	CDWQMSListAppointments(context.Context, string) ([]CDWQMSAppointment, error)
	CDWQMSPendingReview(context.Context, string, int) ([]CDWQMSPendingReview, error)
	CDWFormalClass(context.Context, string) (CDWDocumentClassification, error)
	CDWFormalClassify(context.Context, string, string, string, string) (CDWDocumentClassification, error)
	CDWPublishFormalTemplate(context.Context, string, string, []CDWFormalStepDefinition, string, string) (string, error)
	CDWGrantFormalApprover(context.Context, string, string, string, string, string) (string, error)
	CDWFormalDeliveryFile(context.Context, string) (string, error)
	CDWFormalApprovalFile(context.Context, string) (string, error)
	CDWStartFormalApproval(context.Context, string, string, string, string, string, string) (CDWFormalApproval, error)
	CDWDecideFormalApproval(context.Context, string, string, string, int64, string, string, string) (CDWFormalApproval, error)
	CDWFormalReady(context.Context, int) ([]CDWFormalReadyDelivery, error)
	CDWFormalInbox(context.Context, string, int) ([]CDWFormalApproval, error)
	CDWFormalDetail(context.Context, string) (CDWFormalDetail, error)
	CDWFormalCanRead(context.Context, string, string) (bool, error)
	CDWFormalBlobSource(context.Context, string) (CDWBranchSource, error)
	CDWFormalEvent(context.Context, string, string, string, string, map[string]any) error
}
