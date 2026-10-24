package application

import(
 "context"
 "crypto/ed25519"
 "crypto/sha256"
 "encoding/base64"
 "encoding/hex"
 "encoding/json"
 "errors"
 "filesmanage/internal/domain"
 "filesmanage/internal/ports"
 "os"
 "strings"
 "golang.org/x/crypto/bcrypt"
)

// No corporate signing policy or key is bundled. Absent the public key
// provisioned OUTSIDE source control, no trial Gate candidate can be issued.
// A signed candidate is NOT a legal electronic signature or Stage accepted.
const dhfPilotTrustedGatePublicKeyEnv="DHF_PILOT_GATE_TRUSTED_PUBKEY_B64"

type DHFPilotGateCandidateOutcome struct{
 CandidateID string `json:"candidateId,omitempty"`
 SubmissionID string `json:"submissionId"`
 PayloadSHA string `json:"payloadSha,omitempty"`
 Replayed bool `json:"replayed"`
 TrialOnly bool `json:"trialOnly"`
 Reason string `json:"reason,omitempty"`
}
type DHFPilotGateChallengeOutcome struct{
 SubmissionID string `json:"submissionId"`
 PayloadBase64 string `json:"payloadBase64,omitempty"`
 PayloadSHA string `json:"payloadSha,omitempty"`
 TrialOnly bool `json:"trialOnly"`
 Reason string `json:"reason,omitempty"`
}
func dhfPilotGatePayload(source ports.DHFPilotGateCandidateSource)[]byte{
 encoded,_:=json.Marshal(struct{
  Domain string `json:"domain"`
  Verdict string `json:"verdict"`
  Submission string `json:"submission"`
  Attempt string `json:"attempt"`
  Project string `json:"project"`
  Stage string `json:"stage"`
  Template string `json:"template"`
  GateAttestation string `json:"gateAttestation"`
  Signer string `json:"signer"`
  PolicySHA string `json:"policySha"`
  ManifestSHA string `json:"manifestSha"`
 }{"DHF-PILOT-GATE-CANDIDATE-V1","trial_candidate",
 source.SubmissionID,source.AttemptID,source.ProjectID,source.StageID,
 source.TemplateID,source.GateAttestationID,source.SignerID,
 source.PolicySHA,source.ManifestSHA})
 return encoded
}
func dhfGateDigest(data []byte)string{
 sum:=sha256.Sum256(data);return hex.EncodeToString(sum[:])
}
func dhfTrustedGateKey()(ed25519.PublicKey,string,bool){
 raw:=strings.TrimSpace(os.Getenv(dhfPilotTrustedGatePublicKeyEnv))
 if raw==""{return nil,"",false}
 decoded,err:=base64.StdEncoding.DecodeString(raw)
 if err!=nil||len(decoded)!=ed25519.PublicKeySize{return nil,"",false}
 return ed25519.PublicKey(decoded),dhfGateDigest(decoded),true
}
// Signature challenge is read-only, participant scoped, and bound to
// current unpublished external trust anchor without exposing any private key.
func(s *Service)DHFPilotGateChallenge(ctx context.Context,actor domain.User,submissionID string)(DHFPilotGateChallengeOutcome,error){
 fail:=func(reason string)DHFPilotGateChallengeOutcome{
  return DHFPilotGateChallengeOutcome{SubmissionID:submissionID,TrialOnly:true,Reason:reason}
 }
 if actor.ID==""||submissionID==""{return fail("DHF_SCOPE_DENIED"),nil}
 if _,_,ok:=dhfTrustedGateKey();!ok{return fail("DHF_GATE_TRUST_POLICY_MISSING"),nil}
 tx,err:=s.uow.Begin(ctx)
 if err!=nil{return fail("DHF_GATE_UNAVAILABLE"),err}
 defer tx.Rollback(ctx)
 store,ok:=any(tx).(ports.DHFPilotGateCandidateStore)
 if !ok{return fail("DHF_GATE_UNAVAILABLE"),errors.New("DHF gate candidate store unavailable")}
 if err=store.DHFPilotBeginSubmission(ctx);err!=nil{return fail("DHF_GATE_UNAVAILABLE"),err}
 source,err:=store.DHFPilotGateCandidateForSigner(ctx,submissionID,actor.ID)
 if errors.Is(err,ports.ErrRowMissing){return fail("DHF_SCOPE_DENIED"),nil}
 if err!=nil{return fail("DHF_GATE_UNAVAILABLE"),err}
 payload:=dhfPilotGatePayload(source)
 return DHFPilotGateChallengeOutcome{SubmissionID:submissionID,
  PayloadBase64:base64.StdEncoding.EncodeToString(payload),
  PayloadSHA:dhfGateDigest(payload),TrialOnly:true},nil
}

// DHFPilotSealGateCandidate does not alter any formal accepted state.
// Signed payload must be verified using a separately provisioned Ed25519
// public key and reviewer's CURRENT password; absent either, deny.
func(s *Service)DHFPilotSealGateCandidate(ctx context.Context,actor domain.User,
 submissionID,password,signatureBase64,key string)(DHFPilotGateCandidateOutcome,error){
 fail:=func(reason string)DHFPilotGateCandidateOutcome{
  return DHFPilotGateCandidateOutcome{SubmissionID:submissionID,Reason:reason,TrialOnly:true}
 }
 if actor.ID==""||submissionID==""{return fail("DHF_SCOPE_DENIED"),nil}
 if len(password)<1||len(password)>1024{return fail("DHF_GATE_REAUTH_FAILED"),nil}
 if len(key)<8||len(key)>160||strings.TrimSpace(key)!=key{return fail("DHF_IDEMPOTENCY_KEY_INVALID"),nil}
 trustedKey,keySHA,ok:=dhfTrustedGateKey()
 if !ok{return fail("DHF_GATE_TRUST_POLICY_MISSING"),nil}
 signature,err:=base64.StdEncoding.DecodeString(signatureBase64)
 if err!=nil||len(signature)!=ed25519.SignatureSize{return fail("DHF_GATE_SIGNATURE_INVALID"),nil}
 tx,err:=s.uow.Begin(ctx)
 if err!=nil{return fail("DHF_GATE_UNAVAILABLE"),err}
 defer tx.Rollback(ctx)
 store,ok:=any(tx).(ports.DHFPilotGateCandidateStore)
 if !ok{return fail("DHF_GATE_UNAVAILABLE"),errors.New("DHF trial Gate store missing")}
 if err=store.DHFPilotBeginSubmission(ctx);err!=nil{return fail("DHF_GATE_UNAVAILABLE"),err}
 source,err:=store.DHFPilotGateCandidateForSigner(ctx,submissionID,actor.ID)
 if errors.Is(err,ports.ErrRowMissing){return fail("DHF_SCOPE_DENIED"),nil}
 if err!=nil{return fail("DHF_GATE_UNAVAILABLE"),err}
 trusted,err:=tx.UserByID(ctx,actor.ID)
 if err!=nil||trusted.ID!=actor.ID||trusted.DisabledAt!=nil||
 trusted.MustChangePassword||trusted.Login==""||actor.Login!=trusted.Login{
  return fail("DHF_SCOPE_DENIED"),nil
 }
 attempts,err:=tx.UserByLogin(ctx,trusted.Login)
 _=attempts
 _=err
 // Rate limit with the same persisted password-denial policy as review
 // attestations, not a new independently bypassable login counter.
 attemptsStore,ok:=any(tx).(ports.DHFPilotAttestationStore)
 if !ok{return fail("DHF_GATE_UNAVAILABLE"),errors.New("reauth audit store unavailable")}
 invalid,err:=attemptsStore.DHFPilotRecentAttestationAuthFailures(ctx,actor.ID)
 if err!=nil{return fail("DHF_GATE_UNAVAILABLE"),err}
 if invalid>=5{return fail("DHF_REAUTH_RATE_LIMITED"),nil}
 current,hash,err:=tx.UserByLogin(ctx,trusted.Login)
 if err!=nil||current.ID!=actor.ID||current.MustChangePassword||
 bcrypt.CompareHashAndPassword([]byte(hash),[]byte(password))!=nil{
  if err=attemptsStore.DHFPilotAuditAttestationAuthFailure(ctx,actor.ID,submissionID);err!=nil{
   return fail("DHF_GATE_UNAVAILABLE"),err
  }
  if err=tx.Commit(ctx);err!=nil{return fail("DHF_GATE_UNAVAILABLE"),err}
  return fail("DHF_GATE_REAUTH_FAILED"),nil
 }
 payload:=dhfPilotGatePayload(source)
 if !ed25519.Verify(trustedKey,payload,signature){
  return fail("DHF_GATE_SIGNATURE_INVALID"),nil
 }
 if s.blobs==nil{return fail("DHF_GATE_EVIDENCE_UNAVAILABLE"),nil}
 pins,err:=store.DHFPilotGateEvidenceForSigner(ctx,submissionID,actor.ID)
 if err!=nil{return fail("DHF_GATE_EVIDENCE_UNAVAILABLE"),err}
 if len(pins)==0{return fail("DHF_GATE_EVIDENCE_UNAVAILABLE"),nil}
 for _,pin:=range pins{
  if _,err=s.visibleFile(ctx,tx,trusted,pin.FileID,domain.ActionPreview);err!=nil{
   return fail("DHF_GATE_EVIDENCE_DENIED"),nil
  }
  version,err:=tx.VersionBySeq(ctx,pin.FileID,pin.VersionSeq)
  if err!=nil||version.BlobID!=pin.BlobID||version.Sha256!=pin.Sha256{
   return fail("DHF_GATE_EVIDENCE_INVALID"),nil
  }
  blob,err:=tx.BlobByID(ctx,pin.BlobID)
  if err!=nil||blob.State!="ready"||blob.Sha256!=pin.Sha256{
   return fail("DHF_GATE_EVIDENCE_INVALID"),nil
  }
  if verifyDHFPilotPhysicalBlob(ctx,s.blobs,blob.StorageKey,pin.Sha256,blob.SizeBytes)!=nil{
   return fail("DHF_GATE_EVIDENCE_INVALID"),nil
  }
 }
 payloadSHA:=dhfGateDigest(payload)
 requestSHA:=hashPilotSubmit(submissionID,actor.ID,key,keySHA,payloadSHA+":"+signatureBase64)
 previous,err:=store.DHFPilotExistingGateCandidate(ctx,submissionID)
 if err==nil{
  if previous.SignerID==actor.ID&&previous.IdempotencyKey==key&&
   previous.RequestSHA==requestSHA&&previous.DecisionPayloadSHA==payloadSHA&&
   previous.TrustedKeySHA==keySHA{
   return DHFPilotGateCandidateOutcome{CandidateID:previous.ID,SubmissionID:submissionID,
    PayloadSHA:payloadSHA,Replayed:true,TrialOnly:true},nil
  }
  return fail("DHF_GATE_CANDIDATE_ALREADY_EXISTS"),nil
 }
 if !errors.Is(err,ports.ErrRowMissing){return fail("DHF_GATE_UNAVAILABLE"),err}
 rec:=ports.DHFPilotGateCandidateRecord{
  ID:NewID("dhfgate"),SubmissionID:source.SubmissionID,AttemptID:source.AttemptID,
  ProjectID:source.ProjectID,StageID:source.StageID,TemplateID:source.TemplateID,
  GateAttestationID:source.GateAttestationID,SignerID:source.SignerID,
  PolicySHA:source.PolicySHA,ManifestSHA:source.ManifestSHA,
  DecisionPayloadSHA:payloadSHA,TrustedKeySHA:keySHA,Signature:signature,
  IdempotencyKey:key,RequestSHA:requestSHA,
 }
 if err=store.DHFPilotPersistGateCandidate(ctx,rec);err!=nil{
  return fail("DHF_GATE_PRECONDITION"),err
 }
 if err=tx.Commit(ctx);err!=nil{return fail("DHF_GATE_PRECONDITION"),err}
 return DHFPilotGateCandidateOutcome{CandidateID:rec.ID,SubmissionID:submissionID,
  PayloadSHA:payloadSHA,TrialOnly:true},nil
}
