package application

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"time"
)

// Deliberately different from the live-signature eligibility decision:
// historical Ed25519 validity does NOT change when a credential is revoked.
type DHFPilotGateVerification struct {
	SubmissionID         string     `json:"submissionId"`
	StageID              string     `json:"stageId"`
	CandidateID          string     `json:"candidateId,omitempty"`
	CandidateStatus      string     `json:"candidateStatus"`
	CryptographicValid   bool       `json:"cryptographicValid"`
	SignatureDomain      string     `json:"signatureDomain,omitempty"`
	SignatureReason      string     `json:"signatureReason,omitempty"`
	CredentialID         string     `json:"credentialId,omitempty"`
	CredentialStatus     string     `json:"credentialStatus"`
	CredentialExpiresAt  *time.Time `json:"credentialExpiresAt,omitempty"`
	SignerID             string     `json:"signerId,omitempty"`
	PayloadSHA           string     `json:"payloadSha,omitempty"`
	KeySHA               string     `json:"keySha,omitempty"`
	MissingPreconditions []string   `json:"missingPreconditions"`
	TrialOnly            bool       `json:"trialOnly"`
	FormalAccepted       bool       `json:"formalAccepted"`
}

// V1's exact field ordering is preserved for migration 0054 historic rows.
// Re-encoding a V1 record with new V2 fields would invalidate its signature.
func dhfPilotGatePayloadV1(s ports.DHFPilotGateCandidateSource) []byte {
	b, _ := json.Marshal(struct {
		Domain          string `json:"domain"`
		Verdict         string `json:"verdict"`
		Submission      string `json:"submission"`
		Attempt         string `json:"attempt"`
		Project         string `json:"project"`
		Stage           string `json:"stage"`
		Template        string `json:"template"`
		GateAttestation string `json:"gateAttestation"`
		Signer          string `json:"signer"`
		PolicySHA       string `json:"policySha"`
		ManifestSHA     string `json:"manifestSha"`
	}{"DHF-PILOT-GATE-CANDIDATE-V1", "trial_candidate", s.SubmissionID, s.AttemptID,
		s.ProjectID, s.StageID, s.TemplateID, s.GateAttestationID, s.SignerID,
		s.PolicySHA, s.ManifestSHA})
	return b
}

func verifyHistoricalDHFPilotGate(rec ports.DHFPilotGateCandidateRecord) (bool, string, string) {
	if len(rec.TrustedPublicKey) != ed25519.PublicKeySize || len(rec.Signature) != ed25519.SignatureSize {
		return false, "", "SIGNATURE_LENGTH_INVALID"
	}
	if dhfGateDigest(rec.TrustedPublicKey) != rec.TrustedKeySHA {
		return false, "", "PUBLIC_KEY_FINGERPRINT_MISMATCH"
	}
	source := ports.DHFPilotGateCandidateSource{
		SubmissionID: rec.SubmissionID, AttemptID: rec.AttemptID,
		ProjectID: rec.ProjectID, StageID: rec.StageID, TemplateID: rec.TemplateID,
		GateAttestationID: rec.GateAttestationID, SignerID: rec.SignerID,
		PolicySHA: rec.PolicySHA, ManifestSHA: rec.ManifestSHA,
	}
	var payload []byte
	domain := "DHF-PILOT-GATE-CANDIDATE-V2"
	if rec.SigningCredentialID == "" {
		domain = "DHF-PILOT-GATE-CANDIDATE-V1"
		payload = dhfPilotGatePayloadV1(source)
	} else {
		payload = dhfPilotGatePayload(source, rec.SigningCredentialID, rec.TrustedKeySHA)
	}
	if dhfGateDigest(payload) != rec.DecisionPayloadSHA {
		return false, domain, "PAYLOAD_DIGEST_MISMATCH"
	}
	if !ed25519.Verify(ed25519.PublicKey(rec.TrustedPublicKey), payload, rec.Signature) {
		return false, domain, "ED25519_SIGNATURE_INVALID"
	}
	return true, domain, ""
}

// Read-only workbench operation; never uses a caller-provided candidate,
// public key, claimed verdict, role, or explicit issuer authority.
func (s *Service) DHFPilotGateVerification(ctx context.Context, actor domain.User, submissionID string) (DHFPilotGateVerification, error) {
	if actor.ID == "" || submissionID == "" {
		return DHFPilotGateVerification{}, ports.ErrRowMissing
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return DHFPilotGateVerification{}, err
	}
	defer tx.Rollback(ctx)
	store, ok := any(tx).(ports.DHFPilotGateHistoryStore)
	if !ok {
		return DHFPilotGateVerification{}, errors.New("DHF Gate historical verification adapter unavailable")
	}
	if err = store.DHFPilotBeginSnapshot(ctx); err != nil {
		return DHFPilotGateVerification{}, err
	}
	trusted, err := tx.UserByID(ctx, actor.ID)
	if err != nil || trusted.ID != actor.ID || trusted.DisabledAt != nil {
		return DHFPilotGateVerification{}, ports.ErrRowMissing
	}
	_, activeTrustKeySHA, _ := dhfTrustedGateKey()
	h, err := store.DHFPilotGateHistoryForSigner(ctx, submissionID, actor.ID, activeTrustKeySHA)
	if err != nil {
		return DHFPilotGateVerification{}, err
	}
	result := DHFPilotGateVerification{SubmissionID: h.SubmissionID, StageID: h.StageID,
		CandidateStatus: "not_issued", CredentialStatus: h.CredentialStatus,
		CredentialExpiresAt: h.CredentialExpiresAt, MissingPreconditions: []string{},
		TrialOnly: true, FormalAccepted: false}
	if h.TotalDuties == 0 {
		result.MissingPreconditions = append(result.MissingPreconditions, "NO_REVIEW_OBLIGATIONS")
	}
	if h.SignedPassedDuties < h.TotalDuties {
		result.MissingPreconditions = append(result.MissingPreconditions, "UNSIGNED_REVIEW_OBLIGATIONS")
	}
	if h.OpenRemediations > 0 {
		result.MissingPreconditions = append(result.MissingPreconditions, "REMEDIATION_NOT_VERIFIED")
	}
	if h.Candidate == nil {
		if h.CredentialStatus != "activate" {
			result.MissingPreconditions = append(result.MissingPreconditions, "SIGNING_CREDENTIAL_NOT_ACTIVE")
		}
		result.SignatureReason = "NO_SIGNED_CANDIDATE"
		return result, nil
	}
	rec := *h.Candidate
	result.CandidateID = rec.ID
	result.CandidateStatus = "trial_candidate"
	result.SignerID = rec.SignerID
	result.PayloadSHA = rec.DecisionPayloadSHA
	result.KeySHA = rec.TrustedKeySHA
	result.CredentialID = rec.SigningCredentialID
	result.CryptographicValid, result.SignatureDomain, result.SignatureReason = verifyHistoricalDHFPilotGate(rec)
	if rec.ProjectID != h.ProjectID || rec.StageID != h.StageID || rec.SubmissionID != h.SubmissionID || rec.SignerID != actor.ID {
		result.CryptographicValid = false
		result.SignatureReason = "CANDIDATE_SCOPE_MISMATCH"
	}
	return result, nil
}
