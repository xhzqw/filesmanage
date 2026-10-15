package ports

import "context"

// A fulfilled obligation is a signed management accountability fact.
// An accepted child delivery alone is never a completion event.
type CDWObligationFulfillment struct {
	ObligationID   string `json:"obligationId"`
	TaskID         string `json:"taskId"`
	FileID         string `json:"fileId"`
	Kind           string `json:"kind"`
	State          string `json:"state"`
	Revision       int64  `json:"revision"`
	FulfilledBy    string `json:"fulfilledBy"`
	EvidenceSHA256 string `json:"evidenceSha256"`
	FulfilledAt    string `json:"fulfilledAt"`
}
type CDWObligationStore interface {
	CDWObligationFile(context.Context, string) (string, error)
	CDWFulfillObligation(context.Context, string, string, int64, string, string) (CDWObligationFulfillment, error)
	CDWObligationEvent(context.Context, string, string, string, CDWObligationFulfillment) error
}
