package application

import (
 "context"
 "encoding/json"
 "errors"
 "filesmanage/internal/domain"
 "filesmanage/internal/ports"
 "time"
)

type DHFPilotReturnInboxItem struct {
 DecisionID string `json:"decisionId"`
 ReviewKey string `json:"reviewKey"`
 ProjectID string `json:"projectId"`
 StageID string `json:"stageId"`
 OriginalSubmissionID string `json:"originalSubmissionId"`
 OriginalManifest json.RawMessage `json:"originalManifest"`
 OriginalManifestSHA string `json:"originalManifestSha"`
 ReturnReason string `json:"returnReason"`
 DecidedAt time.Time `json:"decidedAt"`
 CaseID string `json:"caseId,omitempty"`
 NewAttemptID string `json:"newAttemptId,omitempty"`
 NewAttemptState string `json:"newAttemptState,omitempty"`
 VerificationID string `json:"verificationId,omitempty"`
 CanPrepare bool `json:"canPrepare"`
}

// Scopes returned findings by source submitter, not reviewer and not admin.
// A read-only task projection never grants file access or signature rights.
func(s *Service)DHFPilotReturnInbox(ctx context.Context,actor domain.User)([]DHFPilotReturnInboxItem,error){
 if actor.ID==""{return nil,domain.ErrForbidden}
 tx,err:=s.uow.Begin(ctx)
 if err!=nil{return nil,err}
 defer tx.Rollback(ctx)
 store,ok:=any(tx).(ports.DHFPilotReturnInboxStore)
 if !ok{return nil,errors.New("DHF return inbox adapter unavailable")}
 if err=store.DHFPilotBeginSnapshot(ctx);err!=nil{return nil,err}
 user,err:=tx.UserByID(ctx,actor.ID)
 if err!=nil||user.ID!=actor.ID||user.DisabledAt!=nil{return nil,domain.ErrForbidden}
 rows,err:=store.DHFPilotReturnsForAuthor(ctx,actor.ID,100)
 if err!=nil{return nil,err}
 out:=make([]DHFPilotReturnInboxItem,0,len(rows))
 for _,r:=range rows{
  if !checkPilotHash(r.OriginalManifest,r.OriginalManifestSHA){
   return nil,errors.New("DHF returned source manifest digest mismatch")
  }
  var source dhfPilotManifest
  if decodePilotJSON(r.OriginalManifest,&source)!=nil{return nil,errors.New("invalid returned manifest")}
  out=append(out,DHFPilotReturnInboxItem{
   DecisionID:r.DecisionID,ReviewKey:r.ReviewKey,ProjectID:r.ProjectID,
   StageID:r.StageID,OriginalSubmissionID:r.OriginalSubmissionID,
   OriginalManifest:json.RawMessage(r.OriginalManifest),OriginalManifestSHA:r.OriginalManifestSHA,
   ReturnReason:r.Reason,DecidedAt:r.DecidedAt,
   CaseID:r.CaseID,NewAttemptID:r.NewAttemptID,
   NewAttemptState:r.NewAttemptState,VerificationID:r.VerificationID,CanPrepare:r.CanPrepare,
  })
 }
 return out,nil
}
