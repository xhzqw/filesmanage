package postgres

import (
 "context"
 "errors"
 "filesmanage/internal/ports"
 "github.com/jackc/pgx/v5"
)
var _ ports.DHFPilotRemediationVerificationStore=(*Repository)(nil)

// Only the signer of the original returned opinion can verify correction.
func(r *Repository)DHFPilotVerificationCandidate(ctx context.Context,caseID,actorID string)(ports.DHFPilotVerificationCandidate,error){
 var x ports.DHFPilotVerificationCandidate
 if caseID==""||actorID==""{return x,ports.ErrRowMissing}
 err:=r.Q.QueryRow(ctx,`
 SELECT c.id,c.return_decision_id,orig_att.id,c.original_submission_id,
   revised.id,old_dec.reviewer_id,c.original_manifest_sha,c.revised_manifest_sha,revised.policy_sha
 FROM dhf_pilot_remediation_cases c
 JOIN dhf_pilot_review_decisions old_dec ON old_dec.id=c.return_decision_id
   AND old_dec.outcome='recommend_return'
 JOIN dhf_pilot_review_attestations orig_att ON orig_att.review_decision_id=old_dec.id
   AND orig_att.outcome='recommend_return' AND orig_att.signer_id=old_dec.reviewer_id
 JOIN dhf_pilot_submissions revised ON revised.attempt_id=c.new_attempt_id
   AND revised.project_id=c.project_id AND revised.stage_id=c.stage_id
   AND revised.template_id=c.template_id AND revised.manifest_sha=c.revised_manifest_sha
 JOIN dhf_pilot_projects project ON project.id=c.project_id AND project.state='active'
 JOIN dhf_pilot_baselines baseline ON baseline.project_id=c.project_id
   AND baseline.stage_id=c.stage_id AND baseline.template_id=c.template_id AND baseline.active
 JOIN dhf_pilot_templates template ON template.id=c.template_id AND template.status='published'
 JOIN dhf_pilot_members reviewer ON reviewer.project_id=c.project_id
   AND reviewer.user_id=old_dec.reviewer_id
 JOIN users actor ON actor.id=old_dec.reviewer_id AND actor.disabled_at IS NULL
   AND NOT actor.must_change_password
 WHERE c.id=$1 AND old_dec.reviewer_id=$2
 FOR UPDATE OF c`,caseID,actorID).
 Scan(&x.CaseID,&x.OriginalReturnDecisionID,&x.OriginalReturnAttestationID,
  &x.OriginalSubmissionID,&x.RevisedSubmissionID,&x.VerifierID,
  &x.OriginalManifestSHA,&x.RevisedManifestSHA,&x.RevisedPolicySHA)
 if errors.Is(err,pgx.ErrNoRows){return x,ports.ErrRowMissing}
 return x,err
}

func(r *Repository)DHFPilotExistingVerification(ctx context.Context,caseID string)(ports.DHFPilotVerificationRecord,error){
 var row ports.DHFPilotVerificationRecord
 err:=r.Q.QueryRow(ctx,`
 SELECT id,case_id,original_return_attestation_id,revised_submission_id,
  verifier_id,comment,original_manifest_sha,revised_manifest_sha,
  revised_policy_sha,idempotency_key,request_sha
 FROM dhf_pilot_remediation_verifications WHERE case_id=$1`,caseID).
 Scan(&row.ID,&row.CaseID,&row.OriginalReturnAttestationID,
  &row.RevisedSubmissionID,&row.VerifierID,&row.Comment,
  &row.OriginalManifestSHA,&row.RevisedManifestSHA,&row.RevisedPolicySHA,
  &row.IdempotencyKey,&row.RequestSHA)
 if errors.Is(err,pgx.ErrNoRows){return row,ports.ErrRowMissing}
 return row,err
}
func(r *Repository)DHFPilotPersistVerification(ctx context.Context,rec ports.DHFPilotVerificationRecord)error{
 if rec.ID==""||rec.CaseID==""||rec.VerifierID==""||rec.RevisedSubmissionID==""{
  return errors.New("missing DHF corrected case verification")
 }
 _,err:=r.Q.Exec(ctx,`
 INSERT INTO dhf_pilot_remediation_verifications(
 id,case_id,original_return_attestation_id,revised_submission_id,
 verifier_id,comment,original_manifest_sha,revised_manifest_sha,
 revised_policy_sha,idempotency_key,request_sha)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
 rec.ID,rec.CaseID,rec.OriginalReturnAttestationID,
 rec.RevisedSubmissionID,rec.VerifierID,rec.Comment,
 rec.OriginalManifestSHA,rec.RevisedManifestSHA,rec.RevisedPolicySHA,
 rec.IdempotencyKey,rec.RequestSHA)
 if err!=nil{return err}
 _,err=r.Q.Exec(ctx,`
 INSERT INTO audit_events(actor_id,event_type,target_kind,target_id,request_id,outcome,details)
 VALUES($1,'dhf.pilot.remediation.verified','dhf_remediation',$2,$3,'success',
 jsonb_build_object('verificationId',$4::text,'originalReturnAttestationId',$5::text,
  'revisedSubmissionId',$6::text,'revisedManifestSha',$7::text))`,
 rec.VerifierID,rec.CaseID,rec.IdempotencyKey,rec.ID,
 rec.OriginalReturnAttestationID,rec.RevisedSubmissionID,rec.RevisedManifestSHA)
 return err
}
