package domain

import "time"

// ApprovalEvent is immutable, written in the same DB transaction as the
// matching approval transition, and ordered by monotonic ID.
type ApprovalEvent struct {
 ID int64 `json:"id"`
 ApprovalID string `json:"approvalId"`
 ActorID string `json:"actorId"`
 ActorName string `json:"actorName"`
 Kind string `json:"kind"`
 StepIndex int `json:"stepIndex"`
 Comment string `json:"comment"`
 CreatedAt time.Time `json:"createdAt"`
}
type ApprovalNotification struct{
 ID int64 `json:"id"`
 ApprovalID string `json:"approvalId"`
 FileName string `json:"fileName"`
 Kind string `json:"kind"`
 StepIndex int `json:"stepIndex"`
 CreatedAt time.Time `json:"createdAt"`
 Read bool `json:"read"`
}
