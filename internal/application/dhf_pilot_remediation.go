package application

import (
 "context"
 "crypto/sha256"
 "encoding/hex"
 "errors"
 "filesmanage/internal/domain"
 "filesmanage/internal/domain/dhf"
 "filesmanage/internal/ports"
 "strings"
 "unicode/utf8"
)

// Pilot-only remediation is a NEW preparation attempt that points to an
// immutable prior returned review. No state is marked changes_requested,
// accepted, closed, signed or released by this use case.
type DHFPilotRemediationOutcome struct {
 CaseID string `json:"caseId,omitempty"`
 ReturnDecisionID string `json:"returnDecisionId"`
 OriginalSubmissionID string `json:"originalSubmissionId,omitempty"`
 NewAttemptID string `json:"newAttemptId,omitempty"`
 Replayed bool `json:"replayed"`
 TrialOnly bool `json:"trialOnly"`
 Reason string `json:"reason,omitempty"`
}

func changedPilotManifest(oldBytes,revisedBytes []byte)bool{
 var oldDoc,newDoc dhfPilotManifest
 if decodePilotJSON(oldBytes,&oldDoc)!=nil||decodePilotJSON(revisedBytes,&newDoc)!=nil{return false}
 if len(oldDoc.Requirements)==0||len(oldDoc.Requirements)>1024||len(newDoc.Requirements)!=len(oldDoc.Requirements){return false}
 original:=map[string]dhfPilotEvidence{}
 for _,item:=range oldDoc.Requirements{
  if item.ID==""||original[item.ID].ID!=""{return false}
  original[item.ID]=item
 }
 seen:=map[string]bool{}
 modified:=false
 for _,item:=range newDoc.Requirements{
  previous,exists:=original[item.ID]
  if !exists||seen[item.ID]||item.VersionSeq<0 {return false}
  seen[item.ID]=true
  if (item.FileID=="" && (item.VersionSeq!=0||item.Sha256!=""))||
     (item.FileID!="" && (item.VersionSeq<1||len(item.Sha256)!=64)){return false}
  if previous!=item{modified=true}
 }
 return len(seen)==len(original)&&modified
}

func(s *Service)DHFPilotOpenRemediation(ctx context.Context,actor domain.User,
 decisionID string,revisedManifest []byte,plan,key string)(DHFPilotRemediationOutcome,error){
 fail:=func(reason string)DHFPilotRemediationOutcome{
  return DHFPilotRemediationOutcome{ReturnDecisionID:decisionID,Reason:reason,TrialOnly:true}
 }
 if actor.ID==""||decisionID==""{return fail("DHF_SCOPE_DENIED"),nil}
 if len(key)<8||len(key)>160||strings.TrimSpace(key)!=key{
  return fail("DHF_IDEMPOTENCY_KEY_INVALID"),nil
 }
 plan=strings.TrimSpace(plan)
 if utf8.RuneCountInString(plan)<10||utf8.RuneCountInString(plan)>2000{
  return fail("DHF_REMEDIATION_PLAN_INVALID"),nil
 }
 if len(revisedManifest)<2||len(revisedManifest)>1048576{
  return fail("DHF_REMEDIATION_MANIFEST_INVALID"),nil
 }
 newHash:=sha256.Sum256(revisedManifest)
 revisedSHA:=hex.EncodeToString(newHash[:])
 tx,err:=s.uow.Begin(ctx)
 if err!=nil{return fail("DHF_REMEDIATION_UNAVAILABLE"),err}
 defer tx.Rollback(ctx)
 store,ok:=any(tx).(ports.DHFPilotRemediationStore)
 if !ok{return fail("DHF_REMEDIATION_UNAVAILABLE"),errors.New("DHF remediation adapter unavailable")}
 if err=store.DHFPilotBeginSubmission(ctx);err!=nil{
  return fail("DHF_REMEDIATION_UNAVAILABLE"),err
 }
 returned,err:=store.DHFPilotReturnedReviewForActor(ctx,decisionID,actor.ID)
 if errors.Is(err,ports.ErrRowMissing){return fail("DHF_SCOPE_DENIED"),nil}
 if err!=nil{return fail("DHF_REMEDIATION_UNAVAILABLE"),err}
 trusted,err:=tx.UserByID(ctx,actor.ID)
 if err!=nil||trusted.ID!=actor.ID||trusted.DisabledAt!=nil{
  return fail("DHF_SCOPE_DENIED"),nil
 }
 if returned.OriginalManifestSHA==revisedSHA||
    !changedPilotManifest(returned.OriginalManifest,revisedManifest){
  return fail("DHF_REMEDIATION_EVIDENCE_UNCHANGED"),nil
 }
 requestSHA:=hashPilotSubmit(decisionID,actor.ID,key,returned.OriginalManifestSHA,revisedSHA+":"+plan)
 prior,err:=store.DHFPilotRemediationForReturn(ctx,decisionID)
 if err==nil{
  if prior.OpenedBy==actor.ID&&prior.IdempotencyKey==key&&
   prior.RequestSHA==requestSHA&&prior.RevisedManifestSHA==revisedSHA&&
   prior.OriginalManifestSHA==returned.OriginalManifestSHA&&prior.ResolutionPlan==plan{
   return DHFPilotRemediationOutcome{ReturnDecisionID:decisionID,
    OriginalSubmissionID:prior.OriginalSubmissionID,CaseID:prior.ID,
    NewAttemptID:prior.NewAttemptID,Replayed:true,TrialOnly:true},nil
  }
  return fail("DHF_REMEDIATION_ALREADY_EXISTS"),nil
 }
 if !errors.Is(err,ports.ErrRowMissing){return fail("DHF_REMEDIATION_UNAVAILABLE"),err}
 record:=ports.DHFPilotRemediationRecord{
  ID:NewID("dhfrem"),ReturnDecisionID:decisionID,
  OriginalSubmissionID:returned.OriginalSubmissionID,
  NewAttemptID:NewID("dhfattempt"),ProjectID:returned.ProjectID,
  StageID:returned.StageID,TemplateID:returned.TemplateID,OpenedBy:actor.ID,
  ResolutionPlan:plan,OriginalManifestSHA:returned.OriginalManifestSHA,
  RevisedManifestSHA:revisedSHA,IdempotencyKey:key,RequestSHA:requestSHA,
 }
 if err=store.DHFPilotPersistRemediation(ctx,record,revisedManifest);err!=nil{
  return fail("DHF_REMEDIATION_CONFLICT"),err
 }
 // A remediation case is immutable. Reject a forged/unusable revised manifest
 // BEFORE committing the case; otherwise one bad request would consume the
 // only rework branch for this submission and strand its legitimate owner.
 snapshot,ok:=any(tx).(ports.DHFPilotSnapshotStore)
 if !ok{return fail("DHF_REMEDIATION_UNAVAILABLE"),errors.New("DHF snapshot adapter unavailable")}
 evaluated,_,_,evalErr:=s.dhfPilotEvaluateTx(ctx,tx,snapshot,actor,record.NewAttemptID,dhf.ActionPrepare)
 if evalErr!=nil{return fail("DHF_REMEDIATION_UNAVAILABLE"),evalErr}
 if evaluated.Decision.Verdict!=dhf.Allow{
  return fail("DHF_REMEDIATION_PREPARE_DENIED"),nil
 }
 if err=tx.Commit(ctx);err!=nil{return fail("DHF_REMEDIATION_CONFLICT"),err}
 return DHFPilotRemediationOutcome{CaseID:record.ID,ReturnDecisionID:decisionID,
  OriginalSubmissionID:record.OriginalSubmissionID,NewAttemptID:record.NewAttemptID,
  TrialOnly:true},nil
}
