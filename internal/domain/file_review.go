package domain

import "time"

// ReviewStatus is a finite-state workflow; the server owns all transitions.
type ReviewStatus string

const (
	ReviewOpen            ReviewStatus = "open"
	ReviewAssigned        ReviewStatus = "assigned"
	ReviewPendingApproval ReviewStatus = "pending_approval"
	ReviewApproved        ReviewStatus = "approved"
	ReviewCompletedSelf   ReviewStatus = "completed_self"
	ReviewRejected        ReviewStatus = "rejected"
)

type FileReviewComment struct {
	ID         int64  `json:"id"`
	FileID     string `json:"fileId"`
	VersionSeq int    `json:"versionSeq"`
	PageNumber *int   `json:"pageNumber,omitempty"`
	LineNumber *int   `json:"lineNumber,omitempty"`
	Body       string `json:"body"`
	// Keep the original author projection for existing clients.
	AuthorID           string       `json:"authorId"`
	AuthorName         string       `json:"authorName"`
	CreatorID          string       `json:"creatorId"`
	CreatorName        string       `json:"creatorName"`
	AssigneeID         string       `json:"assigneeId,omitempty"`
	AssigneeName       string       `json:"assigneeName,omitempty"`
	Status             ReviewStatus `json:"status"`
	Revision           int          `json:"revision"`
	ResolutionNote     string       `json:"resolutionNote,omitempty"`
	ResolvedVersionSeq *int         `json:"resolvedVersionSeq,omitempty"`
	ResolvedAt         *time.Time   `json:"resolvedAt,omitempty"`
	ResolvedBy         string       `json:"resolvedBy,omitempty"`
	ResolvedByName     string       `json:"resolvedByName,omitempty"`
	ApprovalNote       string       `json:"approvalNote,omitempty"`
	ApprovedAt         *time.Time   `json:"approvedAt,omitempty"`
	CreatedAt          time.Time    `json:"createdAt"`
}

type ReviewCommentCounts struct {
	All      int `json:"all"`
	Mine     int `json:"mine"`
	Approval int `json:"approval"`
	Done     int `json:"done"`
}

// ReviewEvent retains immutable receipt ownership across reassignment.
type ReviewEvent struct {
	ID                 int64        `json:"id"`
	ActorID            string       `json:"actorId"`
	ActorName          string       `json:"actorName"`
	Kind               string       `json:"kind"`
	StatusBefore       ReviewStatus `json:"statusBefore"`
	StatusAfter        ReviewStatus `json:"statusAfter"`
	AssigneeID         string       `json:"assigneeId,omitempty"`
	AssigneeName       string       `json:"assigneeName,omitempty"`
	ResolvedBy         string       `json:"resolvedBy,omitempty"`
	ResolvedByName     string       `json:"resolvedByName,omitempty"`
	ResolutionNote     string       `json:"resolutionNote,omitempty"`
	ResolvedVersionSeq *int         `json:"resolvedVersionSeq,omitempty"`
	ApprovalNote       string       `json:"approvalNote,omitempty"`
	CreatedAt          time.Time    `json:"createdAt"`
}

type ReviewNotification struct {
	ID        int64     `json:"id"`
	ReviewID  int64     `json:"reviewId"`
	FileID    string    `json:"fileId"`
	FileName  string    `json:"fileName"`
	Kind      string    `json:"kind"`
	CreatedAt time.Time `json:"createdAt"`
	Read      bool      `json:"read"`
}
