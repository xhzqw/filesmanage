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
