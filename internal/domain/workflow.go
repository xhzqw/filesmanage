package domain

import "time"

// ApprovalPolicy binds a folder to a required approver. While a policy is
// active, saves and rollbacks create pending approvals instead of versions.
type ApprovalPolicy struct {
	FolderID   string
	ApproverID string
	Enabled    bool
	ApproverChain []string
}

// Approval is a pending or decided modification request. The proposed bytes
// live in a staging blob referenced by PayloadBlobID; nothing is published
// until an approval commits it.
type Approval struct {
	ID                 string
	FileID             string
	RequesterID        string
	ApproverID         string
	ApproverChain      []string
	StepIndex          int
	PayloadBlobID      string
	BaseSeq            int
	Action             string
	RollbackTargetSeq  *int
	State              string
	Reason             string
	DecisionComment    string
	CreatedAt          time.Time
	DecidedAt          *time.Time
	FileName           string
	PayloadSha256      string
	PayloadSize        int64
	RequesterName      string
	ApproverName       string
}

// Approval lifecycle states (schema CHECK allows exactly these).
const (
	ApprovalPending    = "pending"
	ApprovalApproved   = "approved"
	ApprovalRejected   = "rejected"
	ApprovalCancelled  = "cancelled"
	ApprovalConflicted = "conflicted"
)

// EditLock is a file-level single-writer lock with a server-side TTL.
type EditLock struct {
	FileID     string
	OwnerID    string
	TokenHash  string
	BaseSeq    int
	ExpiresAt  time.Time
	Generation int64
	OwnerName  string
}

// LockTTL is the server-authoritative lease duration.
const LockTTL = 30 * time.Minute
