package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

var _ ports.DHFPilotGateCandidateStore = (*Repository)(nil)

// A trial trust anchor is not a person's signing authorization. Require the
// same currently active user-bound public key and Gate purpose in the same tx.
func (r *Repository) DHFPilotActiveGateSigningCredential(ctx context.Context, signerID, keySHA string) (string, error) {
	var id string
	err := r.Q.QueryRow(ctx, `
 SELECT c.id FROM dhf_pilot_signing_credentials c
 JOIN LATERAL(SELECT event_kind FROM dhf_pilot_signing_credential_events e
     WHERE e.credential_id=c.id ORDER BY e.event_seq DESC LIMIT 1) latest ON true
 WHERE c.signer_id=$1 AND c.key_sha=$2 AND c.purpose='dhf.pilot.gate.candidate'
   AND c.trial_only AND latest.event_kind='activate'
   AND transaction_timestamp()>=c.valid_from AND transaction_timestamp()<c.expires_at
 FOR SHARE OF c`, signerID, keySHA).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ports.ErrRowMissing
	}
	return id, err
}

// The original FINAL Gate reviewer and frozen submission determine the
// signable candidate: client-supplied actor/manifest/credential IDs ignored.
func (r *Repository) DHFPilotGateCandidateForSigner(ctx context.Context, submissionID, actorID string) (ports.DHFPilotGateCandidateSource, error) {
	var x ports.DHFPilotGateCandidateSource
	if submissionID == "" || actorID == "" {
		return x, ports.ErrRowMissing
	}
	err := r.Q.QueryRow(ctx, `
 SELECT s.id,s.attempt_id,s.project_id,s.stage_id,s.template_id,
  gate.reviewer_id,att.id,s.policy_sha,s.manifest_sha
 FROM dhf_pilot_submissions s
 JOIN dhf_pilot_attempts a ON a.id=s.attempt_id AND a.state='submitted'
 JOIN dhf_pilot_workbench_tasks gate ON gate.submission_id=s.id
    AND gate.review_key='__gate__' AND gate.reviewer_id=$2 AND gate.status='reviewed'
 JOIN dhf_pilot_review_attestations att ON att.task_id=gate.id
    AND att.outcome='recommend_pass' AND att.signer_id=$2
 JOIN dhf_pilot_review_decisions decision ON decision.id=att.review_decision_id
    AND decision.outcome='recommend_pass'
 JOIN dhf_pilot_projects project ON project.id=s.project_id AND project.state='active'
 JOIN dhf_pilot_baselines baseline ON baseline.project_id=s.project_id AND baseline.stage_id=s.stage_id
    AND baseline.template_id=s.template_id AND baseline.active
 JOIN dhf_pilot_templates policy ON policy.id=s.template_id AND policy.status='published'
    AND policy.policy_sha=s.policy_sha
 JOIN dhf_pilot_members member ON member.project_id=s.project_id AND member.user_id=$2
 JOIN users actor ON actor.id=$2 AND actor.disabled_at IS NULL AND NOT actor.must_change_password
 WHERE s.id=$1 AND s.stage_id IN('G5','G6') AND s.submitted_by<>$2
 FOR UPDATE OF gate`, submissionID, actorID).
		Scan(&x.SubmissionID, &x.AttemptID, &x.ProjectID, &x.StageID, &x.TemplateID,
			&x.SignerID, &x.GateAttestationID, &x.PolicySHA, &x.ManifestSHA)
	if errors.Is(err, pgx.ErrNoRows) {
		return x, ports.ErrRowMissing
	}
	return x, err
}
func (r *Repository) DHFPilotExistingGateCandidate(ctx context.Context, submissionID string) (ports.DHFPilotGateCandidateRecord, error) {
	var x ports.DHFPilotGateCandidateRecord
	err := r.Q.QueryRow(ctx, `
 SELECT id,submission_id,attempt_id,project_id,stage_id,template_id,
 gate_attestation_id,signer_id,policy_sha,manifest_sha,
 decision_payload_sha,trusted_key_sha,trusted_public_key_ed25519,signature_ed25519,idempotency_key,request_sha,
 COALESCE(signing_credential_id,'')
 FROM dhf_pilot_gate_candidates WHERE submission_id=$1`, submissionID).
		Scan(&x.ID, &x.SubmissionID, &x.AttemptID, &x.ProjectID, &x.StageID, &x.TemplateID,
			&x.GateAttestationID, &x.SignerID, &x.PolicySHA, &x.ManifestSHA,
			&x.DecisionPayloadSHA, &x.TrustedKeySHA, &x.TrustedPublicKey, &x.Signature, &x.IdempotencyKey, &x.RequestSHA,
			&x.SigningCredentialID)
	if errors.Is(err, pgx.ErrNoRows) {
		return x, ports.ErrRowMissing
	}
	return x, err
}
func (r *Repository) DHFPilotGateEvidenceForSigner(ctx context.Context, submissionID, actorID string) ([]ports.DHFPilotEvidencePin, error) {
	var gateTaskID string
	err := r.Q.QueryRow(ctx, `
 SELECT id FROM dhf_pilot_workbench_tasks
 WHERE submission_id=$1 AND review_key='__gate__' AND reviewer_id=$2
 `, submissionID, actorID).Scan(&gateTaskID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ports.ErrRowMissing
	}
	if err != nil {
		return nil, err
	}
	return r.DHFPilotEvidenceForReviewer(ctx, gateTaskID, actorID)
}
func (r *Repository) DHFPilotPersistGateCandidate(ctx context.Context, rec ports.DHFPilotGateCandidateRecord) error {
	if rec.ID == "" || rec.SubmissionID == "" || rec.SignerID == "" || len(rec.Signature) != 64 || len(rec.TrustedPublicKey) != 32 {
		return errors.New("incomplete independently signed gate candidate")
	}
	_, err := r.Q.Exec(ctx, `
 INSERT INTO dhf_pilot_gate_candidates(id,submission_id,attempt_id,project_id,stage_id,
  template_id,gate_attestation_id,signer_id,policy_sha,manifest_sha,decision_payload_sha,
  trusted_key_sha,trusted_public_key_ed25519,signature_ed25519,idempotency_key,request_sha,signing_credential_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
		rec.ID, rec.SubmissionID, rec.AttemptID, rec.ProjectID, rec.StageID,
		rec.TemplateID, rec.GateAttestationID, rec.SignerID, rec.PolicySHA, rec.ManifestSHA,
		rec.DecisionPayloadSHA, rec.TrustedKeySHA, rec.TrustedPublicKey, rec.Signature, rec.IdempotencyKey, rec.RequestSHA,
		rec.SigningCredentialID)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `
 INSERT INTO audit_events(actor_id,event_type,target_kind,target_id,request_id,outcome,details)
 VALUES($1,'dhf.pilot.gate.candidate','dhf_gate_candidate',$2,$3,'trial_only',
 jsonb_build_object('decisionSha',$4::text,'submissionId',$5::text,
 'trustedKeySha',$6::text,'credentialId',$7::text))`,
		rec.SignerID, rec.ID, rec.IdempotencyKey, rec.DecisionPayloadSHA,
		rec.SubmissionID, rec.TrustedKeySHA, rec.SigningCredentialID)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `
 INSERT INTO outbox_jobs(id,kind,payload)
 VALUES($1,'dhf.pilot.gate.candidate',
  jsonb_build_object('candidateId',$2::text,'decisionSha',$3::text,'submissionId',$4::text,
  'trialOnly',true,'credentialId',$5::text))`,
		"dhf-gate-candidate:"+rec.ID, rec.ID, rec.DecisionPayloadSHA, rec.SubmissionID,
		rec.SigningCredentialID)
	return err
}
