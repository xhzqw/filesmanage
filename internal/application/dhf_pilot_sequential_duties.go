package application

import (
 "context"
 "errors"
 "filesmanage/internal/domain"
 "filesmanage/internal/ports"
 "strings"
 "unicode/utf8"
)

type DHFPilotEarlyInterventionOutcome struct{
 InterventionID string `json:"interventionId,omitempty"`
 TargetTaskID string `json:"targetTaskId"`
 SubmissionID string `json:"submissionId,omitempty"`
 Replayed bool `json:"replayed"`
 TrialOnly bool `json:"trialOnly"`
 Reason string `json:"reason,omitempty"`
}

// A trial authorization for an assigned specialty to review early.
// This is NOT an electronic signature or waiver. All predecessor duty
// rows remain outstanding and Gate acceptance stays disabled.
func(s *Service)DHFPilotAuthorizeEarlyReview(ctx context.Context,actor domain.User,
 targetTaskID,reason,key string)(DHFPilotEarlyInterventionOutcome,error){
 fail:=func(code string)DHFPilotEarlyInterventionOutcome{
  return DHFPilotEarlyInterventionOutcome{TargetTaskID:targetTaskID,TrialOnly:true,Reason:code}
 }
 if actor.ID==""||targetTaskID==""{return fail("DHF_SCOPE_DENIED"),nil}
 if len(key)<8||len(key)>160||strings.TrimSpace(key)!=key{return fail("DHF_IDEMPOTENCY_KEY_INVALID"),nil}
 reason=strings.TrimSpace(reason)
 if utf8.RuneCountInString(reason)<10||utf8.RuneCountInString(reason)>2000{return fail("DHF_INTERVENTION_REASON_INVALID"),nil}
 tx,err:=s.uow.Begin(ctx)
 if err!=nil{return fail("DHF_INTERVENTION_UNAVAILABLE"),err}
 defer tx.Rollback(ctx)
 store,ok:=any(tx).(ports.DHFPilotEarlyInterventionStore)
 if !ok{return fail("DHF_INTERVENTION_UNAVAILABLE"),errors.New("DHF early intervention store unavailable")}
 if err=store.DHFPilotBeginSubmission(ctx);err!=nil{return fail("DHF_INTERVENTION_UNAVAILABLE"),err}
 target,err:=store.DHFPilotEarlyTargetForActor(ctx,targetTaskID,actor.ID)
 if errors.Is(err,ports.ErrRowMissing){return fail("DHF_SCOPE_DENIED"),nil}
 if err!=nil{return fail("DHF_INTERVENTION_UNAVAILABLE"),err}
 trusted,err:=tx.UserByID(ctx,actor.ID)
 if err!=nil||trusted.ID!=actor.ID||trusted.DisabledAt!=nil{return fail("DHF_SCOPE_DENIED"),nil}
 sha:=hashPilotSubmit(targetTaskID,actor.ID,key,target.PolicySHA,target.ManifestSHA+":"+reason)
 existing,err:=store.DHFPilotEarlyInterventionForTarget(ctx,targetTaskID)
 if err==nil{
  if existing.AuthorizedBy==actor.ID&&existing.IdempotencyKey==key&&
   existing.RequestSHA==sha&&existing.PolicySHA==target.PolicySHA&&
   existing.ManifestSHA==target.ManifestSHA&&existing.Reason==reason{
   return DHFPilotEarlyInterventionOutcome{InterventionID:existing.ID,TargetTaskID:targetTaskID,
    SubmissionID:target.SubmissionID,Replayed:true,TrialOnly:true},nil
  }
  return fail("DHF_INTERVENTION_ALREADY_EXISTS"),nil
 }
 if !errors.Is(err,ports.ErrRowMissing){return fail("DHF_INTERVENTION_UNAVAILABLE"),err}
 rec:=ports.DHFPilotEarlyInterventionRecord{
  ID:NewID("dhfearly"),TargetTaskID:targetTaskID,
  SubmissionID:target.SubmissionID,AuthorizedBy:actor.ID,
  Reason:reason,IdempotencyKey:key,RequestSHA:sha,PolicySHA:target.PolicySHA,
  ManifestSHA:target.ManifestSHA,
 }
 if err=store.DHFPilotPersistEarlyIntervention(ctx,rec);err!=nil{
  return fail("DHF_INTERVENTION_CONFLICT"),err
 }
 if err=tx.Commit(ctx);err!=nil{return fail("DHF_INTERVENTION_CONFLICT"),err}
 return DHFPilotEarlyInterventionOutcome{InterventionID:rec.ID,TargetTaskID:targetTaskID,
  SubmissionID:rec.SubmissionID,TrialOnly:true},nil
}

// Query the complete reviewer responsibility chain within the existing
// Workbench. A Gate sponsor cannot see/approve projects where not assigned.
func(s *Service)DHFPilotDutyChain(ctx context.Context,actor domain.User)([]ports.DHFPilotDutySnapshot,error){
 if actor.ID==""{return nil,ErrUnauthorized}
 tx,err:=s.uow.Begin(ctx)
 if err!=nil{return nil,err}
 defer tx.Rollback(ctx)
 store,ok:=any(tx).(ports.DHFPilotDutyReadStore)
 if !ok{return nil,errors.New("DHF duty view unavailable")}
 if err=store.DHFPilotBeginSnapshot(ctx);err!=nil{return nil,err}
 trusted,err:=tx.UserByID(ctx,actor.ID)
 if err!=nil||trusted.ID!=actor.ID||trusted.DisabledAt!=nil{return nil,ErrUnauthorized}
 return store.DHFPilotDutiesForActor(ctx,actor.ID,200)
}
