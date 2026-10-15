package ports

import (
	"context"
	"encoding/json"
	"errors"
)

var ErrCDWIdempotencyReuse = errors.New("CDW idempotency key used for a different request")

// CDWAssignmentTarget has exactly one nonblank kind/id pair.
type CDWAssignmentTarget struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

type CDWTaskCommand struct {
	TaskID            string              `json:"taskId"`
	RootID            string              `json:"rootId"`
	ParentID          string              `json:"parentId,omitempty"`
	AssignmentID      string              `json:"assignmentId"`
	Title             string              `json:"title"`
	FileID            string              `json:"fileId"`
	TemplateVersionID string              `json:"templateVersionId"`
	Target            CDWAssignmentTarget `json:"assignee"`
	Revision          int64               `json:"revision"`
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
	CDWEvent(context.Context, string, string, string, string, CDWTaskResult) error
}
