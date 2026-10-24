package application

import (
 "context"
 "crypto/sha256"
 "encoding/hex"
 "encoding/json"
 "errors"
 "filesmanage/internal/domain"
 "filesmanage/internal/ports"
 "strings"

 "golang.org/x/crypto/bcrypt"
)

// Password reauthentication proves control of the *current* account during
// one transaction. This remains a verified PILOT review attestation, not a
// qualified digital signature, legal e-sign or Stage Gate acceptance.
const DHFPilotAttestationIntent="I confirm this DHF review opinion and its fixed evidence identity"

type DHFPilotAttestationOutcome struct{
 AttestationID string `json:"attestationId,omitempty"`
 TaskID string `json:"taskId"`
 ReviewDecisionID string `json:"reviewDecisionId,omitempty"`
 ContentSHA string `json:"contentSha,omitempty"`
 Replayed bool `json:"replayed"`
 TrialOnly bool `json:"trialOnly"`
 Reason string `json:"reason,omitempty"`
}
func dhfPilotDecisionContentHash(row ports.DHFPilotAttestationDecision)string{
 payload,_:=json.Marshal(struct{
  Source string `json:"source"`
  Decision string `json:"decision"`
  Submission string `json:"submission"`
  Task string `json:"task"`
  Signer string `json:"signer"`
  Outcome string `json:"outcome"`
  Comment string `json:"comment"`
  PolicySHA string `json:"policySha"`
  ManifestSHA string `json:"manifestSha"`
 }{"DHF-PILOT-REVIEW-ATTESTATION-V1",row.DecisionID,row.SubmissionID,row.TaskID,
  row.ReviewerID,row.Outcome,row.Comment,row.PolicySHA,row.ManifestSHA})
 digest:=sha256.Sum256(payload)
 return hex.EncodeToString(digest[:])
}

// Never trusts a caller-provided signer ID, admin role, policy hash, outcome,
// comment or saved password. All are re-read from the same committed source
// decision/active account and project under SERIALIZABLE isolation.
func(s *Service) DHFPilotAttestReview(ctx context.Context,actor domain.User,taskID,decisionID,
 password,intent,key string)(DHFPilotAttestationOutcome,error){
 fail:=func(code string)DHFPilotAttestationOutcome{
  return DHFPilotAttestationOutcome{TaskID:taskID,TrialOnly:true,Reason:code}
 }
 if actor.ID==""||taskID==""||decisionID==""{return fail("DHF_SCOPE_DENIED"),nil}
 if intent!=DHFPilotAttestationIntent{return fail("DHF_ATTESTATION_INTENT_REQUIRED"),nil}
 if len(key)<8||len(key)>160||strings.TrimSpace(key)!=key{return fail("DHF_IDEMPOTENCY_KEY_INVALID"),nil}
 if len(password)<1||len(password)>1024{return fail("DHF_REAUTH_FAILED"),nil}
 tx,err:=s.uow.Begin(ctx)
 if err!=nil{return fail("DHF_ATTESTATION_UNAVAILABLE"),err}
 defer tx.Rollback(ctx)
 store,ok:=any(tx).(ports.DHFPilotAttestationStore)
 if !ok{return fail("DHF_ATTESTATION_UNAVAILABLE"),errors.New("missing DHF attestation store")}
 if err=store.DHFPilotBeginSubmission(ctx);err!=nil{return fail("DHF_ATTESTATION_UNAVAILABLE"),err}
 decision,err:=store.DHFPilotAttestationDecisionForSigner(ctx,taskID,actor.ID)
 if errors.Is(err,ports.ErrRowMissing){return fail("DHF_SCOPE_DENIED"),nil}
 if err!=nil{return fail("DHF_ATTESTATION_UNAVAILABLE"),err}
 if decision.DecisionID!=decisionID{return fail("DHF_SCOPE_DENIED"),nil}
 trusted,err:=tx.UserByID(ctx,actor.ID)
 if err!=nil||trusted.ID!=actor.ID||trusted.DisabledAt!=nil||
   trusted.MustChangePassword||trusted.Login==""||actor.Login!=trusted.Login{
  return fail("DHF_SCOPE_DENIED"),nil
 }
 attempts,err:=store.DHFPilotRecentAttestationAuthFailures(ctx,actor.ID)
 if err!=nil{return fail("DHF_ATTESTATION_UNAVAILABLE"),err}
 if attempts>=5{return fail("DHF_REAUTH_RATE_LIMITED"),nil}
 current,hash,err:=tx.UserByLogin(ctx,trusted.Login)
 if err!=nil||current.ID!=actor.ID||current.MustChangePassword||
  bcrypt.CompareHashAndPassword([]byte(hash),[]byte(password))!=nil{
  if err=store.DHFPilotAuditAttestationAuthFailure(ctx,actor.ID,taskID);err!=nil{
   return fail("DHF_ATTESTATION_UNAVAILABLE"),err
  }
  if err=tx.Commit(ctx);err!=nil{return fail("DHF_ATTESTATION_UNAVAILABLE"),err}
  return fail("DHF_REAUTH_FAILED"),nil
 }
 contentSHA:=dhfPilotDecisionContentHash(decision)
 requestSHA:=hashPilotSubmit(taskID,actor.ID,key,decision.DecisionID,contentSHA)
 previous,err:=store.DHFPilotAttestationForTask(ctx,taskID)
 if err==nil{
  if previous.ReviewDecisionID==decision.DecisionID&&previous.SignerID==actor.ID&&
    previous.IdempotencyKey==key&&previous.RequestSHA==requestSHA&&
    previous.ContentSHA==contentSHA&&previous.PolicySHA==decision.PolicySHA&&
    previous.ManifestSHA==decision.ManifestSHA{
   return DHFPilotAttestationOutcome{AttestationID:previous.ID,TaskID:taskID,
    ReviewDecisionID:decision.DecisionID,ContentSHA:contentSHA,Replayed:true,TrialOnly:true},nil
  }
  return fail("DHF_ATTESTATION_ALREADY_EXISTS"),nil
 }
 if !errors.Is(err,ports.ErrRowMissing){return fail("DHF_ATTESTATION_UNAVAILABLE"),err}
 record:=ports.DHFPilotAttestationRecord{
  ID:NewID("dhfattest"),ReviewDecisionID:decision.DecisionID,TaskID:taskID,
  SubmissionID:decision.SubmissionID,SignerID:actor.ID,Outcome:decision.Outcome,
  SignIntent:DHFPilotAttestationIntent,PolicySHA:decision.PolicySHA,
  ManifestSHA:decision.ManifestSHA,ContentSHA:contentSHA,
  IdempotencyKey:key,RequestSHA:requestSHA,
 }
 if err=store.DHFPilotPersistAttestation(ctx,record);err!=nil{
  return fail("DHF_ATTESTATION_CONFLICT"),err
 }
 if err=tx.Commit(ctx);err!=nil{return fail("DHF_ATTESTATION_CONFLICT"),err}
 return DHFPilotAttestationOutcome{AttestationID:record.ID,TaskID:taskID,
  ReviewDecisionID:decision.DecisionID,ContentSHA:contentSHA,TrialOnly:true},nil
}
