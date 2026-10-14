package httpx

import (
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
)

func approvalPayload(a domain.Approval) gin.H {
	payload := gin.H{
		"id": a.ID, "fileId": a.FileID, "fileName": a.FileName,
		"requesterId": a.RequesterID, "requesterName": a.RequesterName,
		"approverIds":a.ApproverChain,"stepIndex":a.StepIndex,"stepTotal":len(a.ApproverChain),
		"approverId": a.ApproverID, "approverName": a.ApproverName,
		"baseSeq": a.BaseSeq, "action": a.Action, "state": a.State,
		"reason": a.Reason, "decisionComment": a.DecisionComment,
		"payloadSha256": a.PayloadSha256, "payloadSize": a.PayloadSize,
		"createdAt": a.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"),
	}
	if a.RollbackTargetSeq != nil {
		payload["rollbackTargetSeq"] = *a.RollbackTargetSeq
	}
	if a.DecidedAt != nil {
		payload["decidedAt"] = a.DecidedAt.UTC().Format("2006-01-02T15:04:05Z")
	}
	return payload
}
