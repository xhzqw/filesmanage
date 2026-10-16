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
type CDWQMSSpecialAuthority struct {
	ID                    string                   `json:"id"`
	FileID                string                   `json:"fileId"`
	FileName              string                   `json:"fileName"`
	Kind                  string                   `json:"kind"`
	TemplateVersionID     string                   `json:"templateVersionId"`
	PolicyReleaseID       string                   `json:"policyReleaseId"`
	PolicyFileID          string                   `json:"policyFileId"`
	PolicyName            string                   `json:"policyName"`
	Status                string                   `json:"status"`
	Reason                string                   `json:"reason"`
	ProposedBy            string                   `json:"proposedBy"`
	VerifiedBy            string                   `json:"verifiedBy,omitempty"`
	VerificationStatement string                   `json:"verificationStatement,omitempty"`
	NodeClaims            []CDWQMSSpecialNodeClaim `json:"nodeClaims"`
	ReviewedBy            string                   `json:"reviewedBy,omitempty"`
	ReviewReason          string                   `json:"reviewReason,omitempty"`
}
type CDWQMSSpecialNodeClaim struct {
	NodeKey      string `json:"nodeKey"`
	ClauseRef    string `json:"clauseRef"`
	BasisSummary string `json:"basisSummary"`
}
type CDWQMSSpecialAlert struct {
	ID          string  `json:"id"`
	AuthorityID string  `json:"authorityId"`
	FileID      string  `json:"fileId"`
	Kind        string  `json:"kind"`
	EventKind   string  `json:"eventKind"`
	CreatedAt   string  `json:"createdAt"`
	ReadAt      *string `json:"readAt,omitempty"`
}
type CDWQMSSpecialPolicyImpact struct {
	ID            string `json:"id"`
	AuthorityID   string `json:"authorityId"`
	SubjectFileID string `json:"subjectFileId"`
	SubjectName   string `json:"subjectName"`
	PolicyFileID  string `json:"policyFileId"`
	OldReleaseID  string `json:"oldReleaseId"`
	NewReleaseID  string `json:"newReleaseId,omitempty"`
	SourceKind    string `json:"sourceKind"`
	State         string `json:"state"`
	DetectedAt    string `json:"detectedAt"`
	Assessment    string `json:"assessment,omitempty"`
	Disposition   string `json:"disposition,omitempty"`
}
type CDWQMSSpecialEvidenceSource struct {
	CDWBranchSource
	SHA256    string
	ReleaseID string
	Format    string
}

// All mutations run inside the caller's UnitOfWork transaction.
type CDWFormalStore interface {
	CDWQMSSpecialEvidenceSource(context.Context, string) (CDWQMSSpecialEvidenceSource, error)
	CDWQMSSpecialImpacts(context.Context, string, int) ([]CDWQMSSpecialPolicyImpact, error)
	CDWQMSSpecialAssessImpact(context.Context, string, string, string, string) (CDWQMSSpecialPolicyImpact, error)
	CDWQMSSpecialImpactFiles(context.Context, string) (string, string, error)
	CDWQMSSpecialPropose(context.Context, string, string, string, string, string, string, string, []CDWQMSSpecialNodeClaim) (CDWQMSSpecialAuthority, error)
	CDWQMSSpecialReview(context.Context, string, string, string, string) (CDWQMSSpecialAuthority, error)
	CDWQMSSpecialFile(context.Context, string) (string, string, error)
	CDWQMSSpecialList(context.Context, string, int) ([]CDWQMSSpecialAuthority, error)
	CDWQMSSpecialAlerts(context.Context, string, int) ([]CDWQMSSpecialAlert, error)
	CDWQMSSpecialReadAlert(context.Context, string, string) (bool, error)
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
