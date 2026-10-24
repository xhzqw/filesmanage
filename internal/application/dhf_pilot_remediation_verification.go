package application

import (
 "context"
 "errors"
 "filesmanage/internal/domain"
 "filesmanage/internal/ports"
 "strings"
 "unicode/utf8"
 "golang.org/x/crypto/bcrypt"
)

const DHFPilotVerificationIntent="I personally verified the corrected DHF submission against my original return"
type DHFPilotVerificationOutcome struct{
 VerificationID string `json:"verificationId,omitempty"`
 CaseID string `json:"caseId"`
 RevisedSubmissionID string `json:"revisedSubmissionId,omitempty"`
 Replayed bool `json:"replayed"`
 TrialOnly bool `json:"trialOnly"`
 Reason string `json:"reason,omitempty"`
}

// Remediation verification is NOT official Stage Gate acceptance.
func(s *Service)DHFPilotVerifyRemediation(ctx context.Context,actor domain.User,
 caseID,comment,password,intent,key string)(DHFPilotVerificationOutcome,error){
 fail:=func(code string)DHFPilotVerificationOutcome{
  return DHFPilotVerificationOutcome{CaseID:caseID,TrialOnly:true,Reason:code}
 }
 if actor.ID==""||caseID==""{return fail("DHF_SCOPE_DENIED"),nil}
 comment=strings.TrimSpace(comment)
 if utf8.RuneCountInString(comment)<10||utf8.RuneCountInString(comment)>2000{
  return fail("DHF_VERIFICATION_COMMENT_INVALID"),nil
 }
 if intent!=DHFPilotVerificationIntent{return fail("DHF_VERIFICATION_INTENT_REQUIRED"),nil}
 if len(password)<1||len(password)>1024{return fail("DHF_REAUTH_FAILED"),nil}
 if len(key)<8||len(key)>160||strings.TrimSpace(key)!=key{
  return fail("DHF_IDEMPOTENCY_KEY_INVALID"),nil
 }
 tx,err:=s.uow.Begin(ctx)
 if err!=nil{return fail("DHF_VERIFICATION_UNAVAILABLE"),err}
 defer tx.Rollback(ctx)
 store,ok:=any(tx).(ports.DHFPilotRemediationVerificationStore)
 if !ok{return fail("DHF_VERIFICATION_UNAVAILABLE"),errors.New("verification store unavailable")}
 if err=store.DHFPilotBeginSubmission(ctx);err!=nil{return fail("DHF_VERIFICATION_UNAVAILABLE"),err}
 source,err:=store.DHFPilotVerificationCandidate(ctx,caseID,actor.ID)
 if errors.Is(err,ports.ErrRowMissing){return fail("DHF_SCOPE_DENIED"),nil}
 if err!=nil{return fail("DHF_VERIFICATION_UNAVAILABLE"),err}
 trusted,err:=tx.UserByID(ctx,actor.ID)
 if err!=nil||trusted.ID!=actor.ID||trusted.DisabledAt!=nil||
 trusted.MustChangePassword||actor.Login!=trusted.Login||trusted.Login==""{
  return fail("DHF_SCOPE_DENIED"),nil
 }
 failures,err:=store.DHFPilotRecentAttestationAuthFailures(ctx,actor.ID)
 if err!=nil{return fail("DHF_VERIFICATION_UNAVAILABLE"),err}
 if failures>=5{return fail("DHF_REAUTH_RATE_LIMITED"),nil}
