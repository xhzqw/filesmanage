package ports

import "context"

type CDWPaperCopy struct {
	ID          string  `json:"id"`
	CopyNo      string  `json:"copyNo"`
	HolderID    string  `json:"holderId"`
	State       string  `json:"state"`
	Revision    int64   `json:"revision"`
	LastEventID *string `json:"lastEventId,omitempty"`
	LastActorID *string `json:"lastActorId,omitempty"`
	LastReason  *string `json:"lastReason,omitempty"`
}
type CDWPaperLedger struct {
	TargetID       string         `json:"targetId"`
	TargetRevision int64          `json:"targetRevision"`
	FileID         string         `json:"fileId"`
	BatchID        string         `json:"batchId"`
	Channel        string         `json:"channel"`
	PaperQuantity  int            `json:"paperQuantity"`
	LotID          string         `json:"lotId,omitempty"`
	Issued         int            `json:"issued"`
	Collected      int            `json:"collected"`
	Destroyed      int            `json:"destroyed"`
	Lost           int            `json:"lost"`
	Waived         int            `json:"waived"`
	Outstanding    int            `json:"outstanding"`
	Copies         []CDWPaperCopy `json:"copies"`
}
type CDWPaperTransition struct {
	CopyID   string `json:"copyId"`
	EventID  string `json:"eventId"`
	Kind     string `json:"kind"`
	State    string `json:"state"`
	Revision int64  `json:"revision"`
	ActorID  string `json:"actorId"`
	Reason   string `json:"reason"`
}
type CDWPaperStore interface {
	CDWPaperTargetFile(context.Context, string) (string, error)
	CDWPaperCopyFile(context.Context, string) (string, error)
	CDWPaperLedger(context.Context, string) (CDWPaperLedger, error)
	CDWPaperIssue(context.Context, string, string, string, int64, []string, []string) (CDWPaperLedger, error)
	CDWPaperTransition(context.Context, string, string, string, int64, string) (CDWPaperTransition, error)
}
