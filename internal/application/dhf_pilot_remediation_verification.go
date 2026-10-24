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
 current,hash,err:=tx.UserByLogin(ctx,trusted.Login)
 if err!=nil||current.ID!=actor.ID||current.MustChangePassword||
 bcrypt.CompareHashAndPassword([]byte(hash),[]byte(password))!=nil{
  if err=store.DHFPilotAuditAttestationAuthFailure(ctx,actor.ID,caseID);err!=nil{
   return fail("DHF_VERIFICATION_UNAVAILABLE"),err
  }
  if err=tx.Commit(ctx);err!=nil{return fail("DHF_VERIFICATION_UNAVAILABLE"),err}
  return fail("DHF_REAUTH_FAILED"),nil
 }
 // Both immutable submissions must remain physically readable with a
 // valid ACL, file version, Blob identity and actual on-disk SHA-256.
 // Neither a database SHA nor a prior recommendation is sufficient.
 if s.blobs==nil{return fail("DHF_VERIFICATION_EVIDENCE_UNAVAILABLE"),nil}
 pins,err:=store.DHFPilotVerificationFrozenEvidence(ctx,caseID,actor.ID)
 if err!=nil{return fail("DHF_VERIFICATION_EVIDENCE_UNAVAILABLE"),err}
 for _,pin:=range pins {
  if _,err=s.visibleFile(ctx,tx,trusted,pin.FileID,domain.ActionPreview);err!=nil{
   return fail("DHF_VERIFICATION_EVIDENCE_DENIED"),nil
  }
  ver,versionErr:=tx.VersionBySeq(ctx,pin.FileID,pin.VersionSeq)
  if versionErr!=nil||ver.BlobID!=pin.BlobID||ver.Sha256!=pin.Sha256{
   return fail("DHF_VERIFICATION_EVIDENCE_INVALID"),nil
  }
  blob,blobErr:=tx.BlobByID(ctx,pin.BlobID)
  if blobErr!=nil||blob.State!="ready"||blob.Sha256!=pin.Sha256{
   return fail("DHF_VERIFICATION_EVIDENCE_INVALID"),nil
  }
  if verifyDHFPilotPhysicalBlob(ctx,s.blobs,blob.StorageKey,pin.Sha256,blob.SizeBytes)!=nil{
   return fail("DHF_VERIFICATION_EVIDENCE_INVALID"),nil
  }
 }
 requestSHA:=hashPilotSubmit(caseID,actor.ID,key,source.RevisedSubmissionID,
  source.RevisedManifestSHA+":"+comment+":"+intent)
 existing,err:=store.DHFPilotExistingVerification(ctx,caseID)
 if err==nil{
  if existing.VerifierID==actor.ID&&existing.IdempotencyKey==key&&
    existing.RequestSHA==requestSHA&&existing.Comment==comment&&
    existing.RevisedSubmissionID==source.RevisedSubmissionID&&
    existing.OriginalReturnAttestationID==source.OriginalReturnAttestationID{
    return DHFPilotVerificationOutcome{VerificationID:existing.ID,CaseID:caseID,
     RevisedSubmissionID:existing.RevisedSubmissionID,Replayed:true,TrialOnly:true},nil
  }
  return fail("DHF_VERIFICATION_ALREADY_EXISTS"),nil
 }
 if !errors.Is(err,ports.ErrRowMissing){return fail("DHF_VERIFICATION_UNAVAILABLE"),err}
 rec:=ports.DHFPilotVerificationRecord{
  ID:NewID("dhfverify"),CaseID:caseID,OriginalReturnAttestationID:source.OriginalReturnAttestationID,
  RevisedSubmissionID:source.RevisedSubmissionID,VerifierID:actor.ID,
  Comment:comment,OriginalManifestSHA:source.OriginalManifestSHA,
  RevisedManifestSHA:source.RevisedManifestSHA,RevisedPolicySHA:source.RevisedPolicySHA,
  IdempotencyKey:key,RequestSHA:requestSHA,
 }
 if err=store.DHFPilotPersistVerification(ctx,rec);err!=nil{
  return fail("DHF_VERIFICATION_PRECONDITION"),err
 }
 if err=tx.Commit(ctx);err!=nil{return fail("DHF_VERIFICATION_PRECONDITION"),err}
 return DHFPilotVerificationOutcome{VerificationID:rec.ID,CaseID:caseID,
  RevisedSubmissionID:rec.RevisedSubmissionID,TrialOnly:true},nil
}
