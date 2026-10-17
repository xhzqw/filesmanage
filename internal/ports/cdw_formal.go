package ports

import (
	"context"
	"encoding/json"
	"time"
)

// Equal sequence numbers are a parallel, unanimous approval group.
type CDWFormalStepDefinition struct {
	NodeKey    string `json:"nodeKey"`
	Sequence   int    `json:"sequence"`
	ApproverID string `json:"approverId"`
}
type CDWFormalApproval struct {
	ID                 string `json:"id"`
	SubjectID          string `json:"subjectId"`
	DeliveryID         string `json:"deliveryId"`
	FileID             string `json:"fileId"`
	FileName           string `json:"fileName,omitempty"`
	SHA256             string `json:"sha256"`
	TemplateVersionID  string `json:"templateVersionId"`
	State              string `json:"state"`
	Revision           int64  `json:"revision"`
	CandidateID        string `json:"candidateId,omitempty"`
	RequestedBy        string `json:"requestedBy"`
	ReplacesApprovalID string `json:"replacesApprovalId,omitempty"`
}
type CDWQMSLegacyAnomaly struct {
	ApprovalInstanceID string `json:"approvalInstanceId"`
	FileID             string `json:"fileId"`
	FileName           string `json:"fileName"`
	TemplateVersionID  string `json:"templateVersionId"`
	RequestedBy        string `json:"requestedBy"`
	CompletedDecisions int    `json:"completedDecisions"`
	SHA256             string `json:"sha256"`
}
type CDWQMSFormalNotice struct {
	ID                 string  `json:"id"`
	ApprovalInstanceID string  `json:"approvalInstanceId"`
	FileID             string  `json:"fileId"`
	RecipientID        string  `json:"recipientId,omitempty"`
	EventKind          string  `json:"eventKind"`
	CreatedAt          string  `json:"createdAt"`
	ReadAt             *string `json:"readAt,omitempty"`
	FollowupAt         *string `json:"followupAt,omitempty"`
	FollowupReason     string  `json:"followupReason,omitempty"`
	FollowupBy         string  `json:"followupBy,omitempty"`
}
type CDWQMSFormalFollowup struct {
	ID                 string `json:"id"`
	NoticeID           string `json:"noticeId"`
	ApprovalInstanceID string `json:"approvalInstanceId"`
	RecipientID        string `json:"recipientId"`
	RequestedBy        string `json:"requestedBy"`
	Reason             string `json:"reason"`
	RequestedAt        string `json:"requestedAt"`
}
type CDWQMSAuditStep struct {
	ApprovalID string `json:"approvalId"`
	StepID     string `json:"stepId"`
	NodeKey    string `json:"nodeKey"`
	Sequence   int    `json:"sequence"`
	ApproverID string `json:"approverId"`
	State      string `json:"state"`
	Mandatory  bool   `json:"mandatory"`
	Revision   int64  `json:"revision"`
}
type CDWQMSAuditDecision struct {
	ApprovalID        string          `json:"approvalId"`
	StepID            string          `json:"stepId"`
	NodeKey           string          `json:"nodeKey"`
	ActorID           string          `json:"actorId"`
	Decision          string          `json:"decision"`
	Reason            string          `json:"reason"`
	SubjectSHA256     string          `json:"subjectSha256"`
	AuthoritySnapshot json.RawMessage `json:"authoritySnapshot"`
	DecidedAt         string          `json:"decidedAt"`
}
type CDWQMSAuditNotice struct {
	ApprovalID     string  `json:"approvalId"`
	NoticeID       string  `json:"noticeId"`
	RecipientID    string  `json:"recipientId"`
	EventKind      string  `json:"eventKind"`
	CreatedAt      string  `json:"createdAt"`
	ReadAt         *string `json:"readAt,omitempty"`
	FollowupBy     string  `json:"followupBy,omitempty"`
	FollowupReason string  `json:"followupReason,omitempty"`
	FollowupAt     *string `json:"followupAt,omitempty"`
}
type CDWQMSAuditFacts struct {
	Steps     []CDWQMSAuditStep     `json:"steps"`
	Decisions []CDWQMSAuditDecision `json:"decisions"`
	Notices   []CDWQMSAuditNotice   `json:"notices"`
}
type CDWQMSClosureStats struct {
	Interrupted         int    `json:"interrupted"`
	Restarted           int    `json:"restarted"`
	UnconfirmedNotices  int    `json:"unconfirmedNotices"`
	ApprovalsInProgress int    `json:"approvalsInProgress"`
	ApprovalsApproved   int    `json:"approvalsApproved"`
	ChainStatus         string `json:"chainStatus"`
}
type CDWQMSAuditPacket struct {
	SchemaVersion string              `json:"schemaVersion"`
	GeneratedAt   string              `json:"generatedAt"`
	RequestedBy   string              `json:"requestedBy"`
	Lineage       CDWQMSFormalLineage `json:"lineage"`
	Closure       CDWQMSClosureStats  `json:"closure"`
	Facts         CDWQMSAuditFacts    `json:"facts"`
}

// Each segment's digest is over its content bytes, while the digest chain
// authenticates segment ordering and detects missing chunks.
type CDWQMSAuditSegment struct {
	Index                 int    `json:"index"`
	FirstApprovalID       string `json:"firstApprovalId"`
	LastApprovalID        string `json:"lastApprovalId"`
	PreviousSegmentSHA256 string `json:"previousSegmentSha256,omitempty"`
	ContentSHA256         string `json:"contentSha256"`
	PayloadBase64         string `json:"payloadBase64"`
}
type CDWQMSAuditSegmentContent struct {
	Nodes []CDWQMSLineageNode `json:"nodes"`
	Facts CDWQMSAuditFacts    `json:"facts"`
}
type CDWQMSAuditSegmentedPacket struct {
	SchemaVersion     string               `json:"schemaVersion"`
	GeneratedAt       string               `json:"generatedAt"`
	RequestedBy       string               `json:"requestedBy"`
	FocusApprovalID   string               `json:"focusApprovalId"`
	RootApprovalID    string               `json:"rootApprovalId"`
	TotalNodes        int                  `json:"totalNodes"`
	TotalSegments     int                  `json:"totalSegments"`
	LastSegmentSHA256 string               `json:"lastSegmentSha256"`
	Complete          bool                 `json:"complete"`
	Closure           CDWQMSClosureStats   `json:"closure"`
	Segments          []CDWQMSAuditSegment `json:"segments"`
}
type CDWQMSPortfolioItem struct {
	FileID             string `json:"fileId"`
	FileName           string `json:"fileName"`
	Approvals          int    `json:"approvals"`
	Interrupted        int    `json:"interrupted"`
	Restarts           int    `json:"restarts"`
	Pending            int    `json:"pending"`
	Approved           int    `json:"approved"`
	UnconfirmedNotices int    `json:"unconfirmedNotices"`
	LastActivityAt     string `json:"lastActivityAt"`
}
type CDWQMSPortfolio struct {
	Items   []CDWQMSPortfolioItem `json:"items"`
	Limit   int                   `json:"limit"`
	HasMore bool                  `json:"hasMore"`
}
type CDWQMSEscalationPolicy struct {
	ID              string  `json:"id"`
	TargetFileID    string  `json:"targetFileId"`
	PolicyReleaseID string  `json:"policyReleaseId"`
	ClauseRef       string  `json:"clauseRef"`
	DelayMinutes    int     `json:"delayMinutes"`
	OwnerID         string  `json:"ownerId"`
	Reason          string  `json:"reason"`
	ProposedBy      string  `json:"proposedBy"`
	Status          string  `json:"status"`
	VerifiedBy      string  `json:"verifiedBy,omitempty"`
	ProposedAt      string  `json:"proposedAt"`
	VerifiedAt      *string `json:"verifiedAt,omitempty"`
}
type CDWQMSEscalationCase struct {
	ID           string  `json:"id"`
	NoticeID     string  `json:"noticeId"`
	PolicyID     string  `json:"policyId"`
	TargetFileID string  `json:"targetFileId"`
	OwnerID      string  `json:"ownerId"`
	EscalatedBy  string  `json:"escalatedBy"`
	Reason       string  `json:"reason"`
	EscalatedAt  string  `json:"escalatedAt"`
	Resolution   string  `json:"resolution,omitempty"`
	ResolvedBy   string  `json:"resolvedBy,omitempty"`
	ResolvedAt   *string `json:"resolvedAt,omitempty"`
}
type CDWQMSEscalationResolution struct {
	ID         string `json:"id"`
	CaseID     string `json:"caseId"`
	ResolvedBy string `json:"resolvedBy"`
	Resolution string `json:"resolution"`
	ResolvedAt string `json:"resolvedAt"`
}
type CDWQMSLegacyHold struct {
	ID                 string `json:"id"`
	ApprovalInstanceID string `json:"approvalInstanceId"`
	FileID             string `json:"fileId"`
	State              string `json:"state"`
}
type CDWQMSLineageNode struct {
	ApprovalID         string  `json:"approvalId"`
	PreviousApprovalID string  `json:"previousApprovalId,omitempty"`
	FileID             string  `json:"fileId"`
	FileName           string  `json:"fileName"`
	SHA256             string  `json:"sha256"`
	TemplateVersionID  string  `json:"templateVersionId"`
	PolicyReleaseID    string  `json:"policyReleaseId,omitempty"`
	State              string  `json:"state"`
	RequestedBy        string  `json:"requestedBy"`
	RequestedAt        string  `json:"requestedAt"`
	CompletedAt        *string `json:"completedAt,omitempty"`
	StepCount          int     `json:"stepCount"`
	ApprovedCount      int     `json:"approvedCount"`
	RejectedCount      int     `json:"rejectedCount"`
	PendingCount       int     `json:"pendingCount"`
	NoticeTotal        int     `json:"noticeTotal"`
	NoticeRead         int     `json:"noticeRead"`
	InterruptionReason string  `json:"interruptionReason,omitempty"`
	CandidateID        string  `json:"candidateId,omitempty"`
}
type CDWQMSFormalLineage struct {
	FocusApprovalID string              `json:"focusApprovalId"`
	Nodes           []CDWQMSLineageNode `json:"nodes"`
	Truncated       bool                `json:"truncated"`
}
type CDWQMSG16Store interface {
	CDWQMSEscalationSourceFile(context.Context, string) (string, error)
	CDWQMSEscalationPolicySourceFile(context.Context, string) (string, error)
	CDWQMSEscalationContextFile(context.Context, string, string) (string, error)
	CDWQMSEscalationPropose(context.Context, string, CDWQMSEscalationPolicy) (CDWQMSEscalationPolicy, error)
	CDWQMSEscalationVerify(context.Context, string, string, string) (CDWQMSEscalationPolicy, error)
	CDWQMSEscalationRevoke(context.Context, string, string, string) (CDWQMSEscalationPolicy, error)
	CDWQMSEscalationPolicies(context.Context, string, int) ([]CDWQMSEscalationPolicy, error)
	CDWQMSEscalationOpen(context.Context, string, string, string, string, string) (CDWQMSEscalationCase, error)
	CDWQMSEscalationResolve(context.Context, string, string, string, string) (CDWQMSEscalationResolution, error)
	CDWQMSEscalationCases(context.Context, string, int) ([]CDWQMSEscalationCase, error)
	CDWQMSAuditBeginSnapshot(context.Context) error
	CDWQMSAuditChainIDs(context.Context, string, int) ([]string, bool, error)
	CDWQMSAuditNodes(context.Context, []string) ([]CDWQMSLineageNode, error)
	CDWQMSPortfolio(context.Context, string, int) (CDWQMSPortfolio, error)
	CDWQMSAuditCanExport(context.Context, string, string) (bool, error)
	CDWQMSAuditFacts(context.Context, []string) (CDWQMSAuditFacts, error)
	CDWQMSFormalFollowup(context.Context, string, string, string, string) (CDWQMSFormalFollowup, error)
	CDWQMSFormalNoticeFile(context.Context, string) (string, error)
	CDWQMSFormalNoticeLedger(context.Context, string, int) ([]CDWQMSFormalNotice, error)
	CDWQMSFormalLineage(context.Context, string) (CDWQMSFormalLineage, error)
	CDWQMSFormalLineageCanRead(context.Context, string, string) (bool, error)
	CDWQMSRequiresRestart(context.Context, string) (bool, error)
	CDWQMSLegacyHoldHistory(context.Context, string, int) ([]CDWQMSLegacyHold, error)
	CDWQMSLegacyAnomalies(context.Context, string, int) ([]CDWQMSLegacyAnomaly, error)
	CDWQMSHoldLegacy(context.Context, string, string, string, string) (CDWQMSLegacyHold, error)
	CDWQMSFormalNotices(context.Context, string, int) ([]CDWQMSFormalNotice, error)
	CDWQMSReadFormalNotice(context.Context, string, string) (bool, error)
	CDWQMSRecordRestart(context.Context, string, string, string, string) error
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
type CDWQMSFormalInterruption struct {
	ID                         string          `json:"id"`
	ApprovalInstanceID         string          `json:"approvalInstanceId"`
	AuthorityID                string          `json:"authorityId"`
	SubjectFileID              string          `json:"subjectFileId"`
	SubjectName                string          `json:"subjectName"`
	PolicyFileID               string          `json:"policyFileId"`
	SubjectSHA256              string          `json:"subjectSha256"`
	TemplateVersionID          string          `json:"templateVersionId"`
	OldPolicyReleaseID         string          `json:"oldPolicyReleaseId"`
	ReplacementPolicyReleaseID string          `json:"replacementPolicyReleaseId,omitempty"`
	Cause                      string          `json:"cause"`
	CompletedDecisions         int             `json:"completedDecisions"`
	InterruptedNodes           json.RawMessage `json:"interruptedNodes"`
	InterruptedAt              string          `json:"interruptedAt"`
}

// All mutations run inside the caller's UnitOfWork transaction.
type CDWFormalStore interface {
	CDWQMSFormalInterruptions(context.Context, string, int) ([]CDWQMSFormalInterruption, error)
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
