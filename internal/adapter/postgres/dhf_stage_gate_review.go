package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"filesmanage/internal/ports"

	"github.com/jackc/pgx/v5"
)

var _ ports.DHFStageGateReviewStore = (*Repository)(nil)

func (r *Repository) DHFStageGateReviewSourceForSigner(ctx context.Context, submissionID, actorID string) (ports.DHFStageGateReviewSource, error) {
	var out ports.DHFStageGateReviewSource
	x := &out.Candidate
	if submissionID == "" || actorID == "" {
		return out, ports.ErrRowMissing
	}
	err := r.Q.QueryRow(ctx, `
SELECT c.id,c.submission_id,c.attempt_id,c.project_id,c.stage_id,c.template_id,
 c.gate_attestation_id,c.signer_id,c.policy_sha,c.manifest_sha,c.decision_payload_sha,
 c.trusted_key_sha,c.trusted_public_key_ed25519,c.signature_ed25519,c.idempotency_key,
 c.request_sha,COALESCE(c.signing_credential_id,''),template.policy_body,
 (template.status='published' AND template.approved_by IS NOT NULL
 AND template.approved_at IS NOT NULL AND template.policy_sha=c.policy_sha
 AND baseline.active AND baseline.template_id=c.template_id AND p.state='active')
FROM dhf_pilot_gate_candidates c
JOIN dhf_pilot_submissions sub ON sub.id=c.submission_id
JOIN dhf_pilot_attempts attempt ON attempt.id=c.attempt_id AND attempt.state='submitted'
JOIN dhf_pilot_projects p ON p.id=sub.project_id
JOIN dhf_pilot_baselines baseline ON baseline.project_id=c.project_id AND baseline.stage_id=c.stage_id
JOIN dhf_pilot_templates template ON template.id=c.template_id
JOIN dhf_pilot_workbench_tasks gate ON gate.submission_id=c.submission_id
 AND gate.review_key='__gate__' AND gate.reviewer_id=$2 AND gate.status='reviewed'
JOIN dhf_pilot_members member ON member.project_id=c.project_id AND member.user_id=$2
JOIN users reviewer ON reviewer.id=$2 AND reviewer.disabled_at IS NULL
 AND NOT reviewer.must_change_password
WHERE c.submission_id=$1 AND c.signer_id=$2 AND sub.submitted_by<>$2
 AND sub.attempt_id=c.attempt_id AND sub.policy_sha=c.policy_sha
 AND sub.manifest_sha=c.manifest_sha AND attempt.manifest_sha=sub.manifest_sha
FOR UPDATE OF attempt`, submissionID, actorID).Scan(&x.ID, &x.SubmissionID, &x.AttemptID,
		&x.ProjectID, &x.StageID, &x.TemplateID, &x.GateAttestationID, &x.SignerID,
		&x.PolicySHA, &x.ManifestSHA, &x.DecisionPayloadSHA, &x.TrustedKeySHA,
		&x.TrustedPublicKey, &x.Signature, &x.IdempotencyKey, &x.RequestSHA,
		&x.SigningCredentialID, &out.PolicyBody, &out.Published)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ports.ErrRowMissing
	}
	return out, err
}
func (r *Repository) DHFStageGateObservedDependency(ctx context.Context, projectID, stageID string) (string, error) {
	var state string
	err := r.Q.QueryRow(ctx, `SELECT state FROM dhf_pilot_stage_positions
WHERE project_id=$1 AND stage_id=$2`, projectID, stageID).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		return "preparing", nil
	}
	return state, err
}
func (r *Repository) DHFStageGateReviewBySubmission(ctx context.Context, submissionID string) (ports.DHFStageGateReviewRecord, error) {
	var x ports.DHFStageGateReviewRecord
	var deps, missing []byte
	err := r.Q.QueryRow(ctx, `SELECT id,submission_id,gate_candidate_id,attempt_id,
 project_id,stage_id,template_id,signer_id,mode,state,policy_sha,manifest_sha,
 candidate_payload_sha,dependency_snapshot,missing_preconditions,idempotency_key,
 request_sha,dependency_snapshot_sha,trial_only FROM dhf_pilot_stage_gate_review_intents
 WHERE submission_id=$1`, submissionID).
		Scan(&x.ID, &x.SubmissionID, &x.CandidateID, &x.AttemptID, &x.ProjectID,
			&x.StageID, &x.TemplateID, &x.SignerID, &x.Mode, &x.State, &x.PolicySHA,
			&x.ManifestSHA, &x.CandidatePayloadSHA, &deps, &missing, &x.IdempotencyKey,
			&x.RequestSHA, &x.DependencySnapshotSHA, &x.TrialOnly)
	if errors.Is(err, pgx.ErrNoRows) {
		return x, ports.ErrRowMissing
	}
	if err != nil {
		return x, err
	}
	if err = json.Unmarshal(deps, &x.Dependencies); err != nil {
		return x, err
	}
	if err = json.Unmarshal(missing, &x.MissingPreconditions); err != nil {
		return x, err
	}
	x.FormalAccepted = false
	return x, nil
}
func (r *Repository) DHFStageGatePersistReview(ctx context.Context, x ports.DHFStageGateReviewRecord) error {
	deps, err := json.Marshal(x.Dependencies)
	if err != nil {
		return err
	}
	missing, err := json.Marshal(x.MissingPreconditions)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO dhf_pilot_stage_gate_review_intents(
 id,submission_id,gate_candidate_id,attempt_id,project_id,stage_id,template_id,
 signer_id,mode,policy_sha,manifest_sha,candidate_payload_sha,
 dependency_snapshot,missing_preconditions,idempotency_key,request_sha)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16)`,
		x.ID, x.SubmissionID, x.CandidateID, x.AttemptID, x.ProjectID, x.StageID, x.TemplateID,
		x.SignerID, x.Mode, x.PolicySHA, x.ManifestSHA, x.CandidatePayloadSHA,
		string(deps), string(missing), x.IdempotencyKey, x.RequestSHA)
	if err != nil {
		return err
	}
	if err = r.Q.QueryRow(ctx, `SELECT dependency_snapshot_sha
 FROM dhf_pilot_stage_gate_review_intents WHERE id=$1`, x.ID).Scan(&x.DependencySnapshotSHA); err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO audit_events(
 actor_id,event_type,target_kind,target_id,request_id,outcome,details)
 VALUES($1,'dhf.pilot.gate.review_requested','dhf_stage_gate_review',$2,$3,'pending_enterprise_authority',
 jsonb_build_object('candidateId',$4::text,'dependencySnapshotSha',$5::text,
 'mode',$6::text,'formalAccepted',false))`, x.SignerID, x.ID, x.IdempotencyKey,
		x.CandidateID, x.DependencySnapshotSHA, x.Mode)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO outbox_jobs(id,kind,payload)
 VALUES($1,'dhf.pilot.gate.review_requested',
 jsonb_build_object('reviewId',$2::text,'candidateId',$3::text,
 'trialOnly',true,'formalAccepted',false))`,
		"dhf-gate-review:"+x.ID, x.ID, x.CandidateID)
	return err
}
