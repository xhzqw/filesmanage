package ports

import "context"

type CDWReceiptTarget struct {
	TargetID       string `json:"targetId"`
	BatchID        string `json:"batchId"`
	FileID         string `json:"fileId"`
	FileName       string `json:"fileName"`
	RevisionLabel  string `json:"revisionLabel"`
	DepartmentID   string `json:"departmentId"`
	ReceiverID     string `json:"receiverId"`
	ManifestSHA256 string `json:"manifestSha256"`
	ArtifactSHA256 string `json:"artifactSha256"`
	State          string `json:"state"`
	Revision       int64  `json:"revision"`
}
type CDWDepartmentReceipt struct {
	ReceiptID      string `json:"receiptId"`
	TargetID       string `json:"targetId"`
	BatchID        string `json:"batchId"`
	FileID         string `json:"fileId"`
	ActorID        string `json:"actorId"`
	State          string `json:"state"`
	Revision       int64  `json:"revision"`
	ManifestSHA256 string `json:"manifestSha256"`
	EvidenceSHA256 string `json:"evidenceSha256"`
	SignedAt       string `json:"signedAt"`
}
type CDWReceiptStore interface {
	CDWReceiptTargets(context.Context, string, int) ([]CDWReceiptTarget, error)
	CDWReceiptTargetFile(context.Context, string) (string, error)
	CDWReceiptAcknowledge(context.Context, string, string, int64, string, string, string) (CDWDepartmentReceipt, error)
	CDWReceiptEvent(context.Context, string, string, string, CDWDepartmentReceipt) error
}
