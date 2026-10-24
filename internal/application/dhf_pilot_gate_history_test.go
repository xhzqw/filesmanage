package application

import (
	"crypto/ed25519"
	"crypto/rand"
	"filesmanage/internal/ports"
	"testing"
)

func TestDHFPilotHistoricalGateVerificationV1V2(t *testing.T) {
	pub, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	source := ports.DHFPilotGateCandidateSource{
		SubmissionID: "submission-test", AttemptID: "attempt-test",
		ProjectID: "project-test", StageID: "G5", TemplateID: "template-test",
		GateAttestationID: "attestation-test", SignerID: "reviewer-test",
		PolicySHA: "0123456789abcdef", ManifestSHA: "fedcba9876543210",
	}
	for _, version := range []string{"V1", "V2"} {
		t.Run(version, func(t *testing.T) {
			rec := ports.DHFPilotGateCandidateRecord{
				SubmissionID: source.SubmissionID, AttemptID: source.AttemptID,
				ProjectID: source.ProjectID, StageID: source.StageID,
				TemplateID: source.TemplateID, GateAttestationID: source.GateAttestationID,
				SignerID: source.SignerID, PolicySHA: source.PolicySHA, ManifestSHA: source.ManifestSHA,
				TrustedPublicKey: append([]byte(nil), pub...), TrustedKeySHA: dhfGateDigest(pub),
			}
			var payload []byte
			if version == "V1" {
				payload = dhfPilotGatePayloadV1(source)
			} else {
				rec.SigningCredentialID = "credential-test"
				payload = dhfPilotGatePayload(source, rec.SigningCredentialID, rec.TrustedKeySHA)
			}
			rec.DecisionPayloadSHA = dhfGateDigest(payload)
			rec.Signature = ed25519.Sign(privateKey, payload)
			ok, domain, reason := verifyHistoricalDHFPilotGate(rec)
			if !ok || reason != "" || domain != "DHF-PILOT-GATE-CANDIDATE-"+version {
				t.Fatalf("real %s signature rejected: %v %s %s", version, ok, domain, reason)
			}
			// Audit identity or frozen manifest tampering breaks the payload
			// digest, even though the original signature bytes remain valid.
			mutated := rec
			mutated.ManifestSHA = "attacker-manifest"
			if ok, _, _ := verifyHistoricalDHFPilotGate(mutated); ok {
				t.Fatal("tampered manifest verified")
			}
			mutated = rec
			mutated.Signature = append([]byte(nil), rec.Signature...)
			mutated.Signature[0] ^= 0x01
			if ok, _, _ := verifyHistoricalDHFPilotGate(mutated); ok {
				t.Fatal("forged Ed25519 verified")
			}
			mutated = rec
			mutated.TrustedPublicKey = append([]byte(nil), rec.TrustedPublicKey...)
			mutated.TrustedPublicKey[0] ^= 0x01
			if ok, _, _ := verifyHistoricalDHFPilotGate(mutated); ok {
				t.Fatal("wrong key verified")
			}
			mutated = rec
			mutated.SigningCredentialID = "different-credential"
			if version == "V2" {
				if ok, _, _ := verifyHistoricalDHFPilotGate(mutated); ok {
					t.Fatal("credential substitution verified")
				}
			}
		})
	}
}
