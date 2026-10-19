package ports

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

var ErrCDWIdempotencyReuse = errors.New("CDW idempotency key used for a different request")

// CDWAssignmentTarget has exactly one nonblank kind/id pair.
type CDWAssignmentTarget struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

type CDWTaskCommand struct {
	TaskID              string              `json:"taskId"`
	RootID              string              `json:"rootId"`
	ParentID            string              `json:"parentId,omitempty"`
	AssignmentID        string              `json:"assignmentId"`
	Title               string              `json:"title"`
	FileID              string              `json:"fileId"`
	TemplateVersionID   string              `json:"templateVersionId"`
	AllowOverrideReview bool                `json:"allowOverrideReview,omitempty"`
	Target              CDWAssignmentTarget `json:"assignee"`
	Revision            int64               `json:"revision"`
}

type CDWTaskResult struct {
	TaskID               string   `json:"taskId"`
	ParentTaskID         string   `json:"parentTaskId,omitempty"`
	ParentRevision       int64    `json:"parentRevision,omitempty"`
	State                string   `json:"state"`
	Revision             int64    `json:"revision"`
	AcceptedBy           string   `json:"actualAcceptorId,omitempty"`
	AssignmentID         string   `json:"assignmentId"`
	RemainingObligations []string `json:"remainingObligations,omitempty"`
}

type CDWInboxItem struct {
	Kind           string `json:"kind"`
	TaskID         string `json:"taskId"`
	Title          string `json:"title"`
	FileID         string `json:"fileId"`
	State          string `json:"state"`
	Revision       int64  `json:"revision"`
	AssignmentID   string `json:"assignmentId,omitempty"`
	ObligationID   string `json:"obligationId,omitempty"`
	ObligationKind string `json:"obligationKind,omitempty"`
}

// CDWInitiatedItem describes an actual task created by the caller. Creator
// visibility is independently rechecked against current file ACL; the creator
// never inherits assignee, review or approval permissions.
type CDWInitiatedItem struct {
	TaskID       string    `json:"taskId"`
	RootID       string    `json:"rootId"`
	ParentID     string    `json:"parentId,omitempty"`
	Title        string    `json:"title"`
	FileID       string    `json:"fileId"`
	State        string    `json:"state"`
	Revision     int64     `json:"revision"`
	CreatedAt    time.Time `json:"createdAt"`
	AssigneeName string    `json:"assigneeName,omitempty"`
}

type CDWInitiatedPage struct {
	Items      []CDWInitiatedItem `json:"items"`
	NextCursor string             `json:"nextCursor,omitempty"`
}

type CDWTraceEvent struct {
	ID          int64     `json:"id"`
	Kind        string    `json:"kind"`
	EvidenceRef string    `json:"evidenceRef"`
	Event       string    `json:"event"`
	ActorName   string    `json:"actorName"`
	OccurredAt  time.Time `json:"occurredAt"`
}
type CDWTracePage struct {
	Items      []CDWTraceEvent `json:"items"`
	NextBefore int64           `json:"nextBefore,omitempty"`
}

// CDWFlowSnapshot is a read-only, evidence-linked view of a creator's task.
// Milestones are real records only: absence is not treated as a passed gate.
type CDWFlowWork struct {
	ID              string `json:"id"`
	ParentID        string `json:"parentId,omitempty"`
	Title           string `json:"title"`
	State           string `json:"state"`
	Round           int    `json:"round"`
	ResponsibleName string `json:"responsibleName,omitempty"`
	CreatedByName   string `json:"createdByName"`
}
type CDWFlowMilestone struct {
	TaskID     string    `json:"taskId"`
	Kind       string    `json:"kind"`
	Reference  string    `json:"reference"`
	State      string    `json:"state"`
	Round      int       `json:"round,omitempty"`
	ActorName  string    `json:"actorName,omitempty"`
	RecordedAt time.Time `json:"recordedAt"`
	Detail     string    `json:"detail,omitempty"`
}
type CDWFlowSnapshot struct {
	TaskID     string             `json:"taskId"`
	RootID     string             `json:"rootId"`
	Works      []CDWFlowWork      `json:"works"`
	Truncated  bool               `json:"truncated"`
	Milestones []CDWFlowMilestone `json:"milestones"`
}

// CDWTaskStore only operates on an existing transaction. Implementations must
// lock task/root rows, validate role bindings in that transaction, and retain
// the original response for exact idempotency replay.
type CDWTaskStore interface {
	CDWClaimOperation(context.Context, string, string, string, string) (json.RawMessage, bool, error)
	CDWCompleteOperation(context.Context, string, string, string, int, CDWTaskResult) error
	CDWActiveRecipients(context.Context, CDWAssignmentTarget) ([]string, error)
	CDWCreateRoot(context.Context, CDWTaskCommand, string) (CDWTaskResult, error)
	CDWTaskScope(context.Context, string) (string, string, string, error)
	CDWAccept(context.Context, string, string, int64) (CDWTaskResult, error)
	CDWDelegate(context.Context, string, string, int64, CDWTaskCommand, [3]string) (CDWTaskResult, error)
	CDWInbox(context.Context, string, int) ([]CDWInboxItem, error)
	CDWInitiated(context.Context, string, int, string) ([]CDWInitiatedItem, error)
	CDWInitiatedAudit(context.Context, string, string, int, int64) (string, []CDWTraceEvent, error)
	CDWInitiatedFlow(context.Context, string, string) (string, CDWFlowSnapshot, error)
	CDWEvent(context.Context, string, string, string, string, CDWTaskResult) error
}
