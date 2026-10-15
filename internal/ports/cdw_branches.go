package ports

import (
	"context"
	"encoding/json"
	"time"
)

type CDWBranch struct {
	ID             string `json:"branchId"`
	TaskID         string `json:"taskId"`
	FileID         string `json:"fileId"`
	BaseVersionID  string `json:"baseVersionId"`
	BaseSHA256     string `json:"baseSha256"`
	State          string `json:"state"`
	Revision       int64  `json:"revision"`
	HeadRevisionID string `json:"headRevisionId,omitempty"`
	Epoch          int64  `json:"editEpoch"`
}

type CDWBranchSession struct {
	ID          string    `json:"sessionId"`
	BranchID    string    `json:"branchId"`
	DocumentKey string    `json:"documentKey"`
	OpenedBy    string    `json:"openedBy"`
	Generation  int64     `json:"generation"`
	Epoch       int64     `json:"editEpoch"`
	State       string    `json:"state"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

type CDWBranchSave struct {
	ID         string `json:"requestId"`
	BranchID   string `json:"branchId"`
	SessionID  string `json:"sessionId"`
	State      string `json:"state"`
	RevisionID string `json:"persistedRevisionId,omitempty"`
	SHA256     string `json:"sha256,omitempty"`
	Generation int64  `json:"generation"`
	Epoch      int64  `json:"editEpoch"`
}

type CDWBranchSource struct {
	StorageKey string
	Name       string
	SizeBytes  int64
}

type CDWBranchFreeze struct {
	DeliveryID   string `json:"deliveryId"`
	BranchID     string `json:"branchId"`
	TaskID       string `json:"taskId"`
	RevisionID   string `json:"branchRevisionId"`
	SHA256       string `json:"sha256"`
	ReviewGateID string `json:"reviewGateId"`
	Revision     int64  `json:"revision"`
}

type CDWBranchStore interface {
	CDWCreateBranch(context.Context, string, string, string, string) (CDWBranch, error)                        // branchID/taskID/fileID/actor
	CDWBranchForActor(context.Context, string, string) (CDWBranch, error)                                      // branchID/actor
	CDWOpenBranchSession(context.Context, string, string, string, string, time.Time) (CDWBranchSession, error) // branch/actor/session/key/expiry
	CDWBranchSessionByKey(context.Context, string) (CDWBranchSession, error)
	CDWBranchSessionByID(context.Context, string) (CDWBranchSession, error)
	CDWBranchSessionSource(context.Context, string) (CDWBranchSource, error)                   // documentKey
	CDWBeginBranchSave(context.Context, string, string, string, string) (CDWBranchSave, error) // branch/session/actor/requestID
	CDWMarkBranchSaveUnknown(context.Context, string) error
	CDWCompleteOperationRaw(context.Context, string, string, string, int, json.RawMessage) error
	CDWBranchEvent(context.Context, string, string, string, string, map[string]any) error
	CDWReadBranchSave(context.Context, string, string, string) (CDWBranchSave, error)                                                        // branch/request/actor
	CDWCommitBranchCallback(context.Context, string, int, string, string, string, int64, string, int64, string) (bool, error)                // key/status,userdata,eventHash,blobID,size,sha,epoch,revisionID
	CDWFreezeBranchDelivery(context.Context, string, string, string, string, string, int64, string, string, string) (CDWBranchFreeze, error) // branch/actor/request/revision/delivery/expected/freeze/gate/idempotency
}
