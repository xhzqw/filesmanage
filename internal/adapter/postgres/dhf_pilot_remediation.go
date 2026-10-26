package postgres

import (
 "context"
 "errors"
 "filesmanage/internal/ports"

 "github.com/jackc/pgx/v5"
)

var _ ports.DHFPilotRemediationStore=(*Repository)(nil)

// A return recommendation has an immutable owner: the original submitter.
// Not even a global admin can open remediation using someone else's return.
// Lock the recommendation before deciding replay or writing a new case.
func(r *Repository)DHFPilotReturnedReviewForActor(ctx context.Context,decisionID,actorID string)(ports.DHFPilotReturnedReview,error){
 var row ports.DHFPilotReturnedReview
 if decisionID==""||actorID==""{return row,ports.ErrRowMissing}
 err:=r.Q.QueryRow(ctx,`
 SELECT d.id,s.id,s.project_id,s.stage_id,s.template_id,s.submitted_by,
        src.manifest_body,src.manifest_sha,d.policy_sha
 FROM dhf_pilot_review_decisions d
 JOIN dhf_pilot_workbench_tasks task ON task.id=d.task_id
 JOIN dhf_pilot_submissions s ON s.id=d.submission_id
 JOIN dhf_pilot_attempts src ON src.id=s.attempt_id AND src.state='submitted'
 JOIN dhf_pilot_projects p ON p.id=s.project_id AND p.state='active'
 JOIN dhf_pilot_baselines baseline ON baseline.project_id=s.project_id
   AND baseline.stage_id=s.stage_id AND baseline.template_id=s.template_id
   AND baseline.active
 JOIN dhf_pilot_templates template ON template.id=s.template_id
   AND template.status='published' AND template.policy_sha=d.policy_sha
 JOIN dhf_pilot_members member ON member.project_id=s.project_id
   AND member.user_id=s.submitted_by AND member.can_prepare
 JOIN users u ON u.id=member.user_id AND u.disabled_at IS NULL
 WHERE d.id=$1 AND s.submitted_by=$2
   AND d.outcome='recommend_return' AND task.status='returned'
 FOR UPDATE OF d `,decisionID,actorID).
 Scan(&row.DecisionID,&row.OriginalSubmissionID,&row.ProjectID,&row.StageID,
  &row.TemplateID,&row.SubmittedBy,&row.OriginalManifest,&row.OriginalManifestSHA,&row.PolicySHA)
 if errors.Is(err,pgx.ErrNoRows){return row,ports.ErrRowMissing}
 return row,err
}

func(r *Repository)DHFPilotRemediationForReturn(ctx context.Context,decisionID string)(ports.DHFPilotRemediationRecord,error){
 var rec ports.DHFPilotRemediationRecord
 err:=r.Q.QueryRow(ctx,`
 SELECT id,return_decision_id,original_submission_id,new_attempt_id,
 project_id,stage_id,template_id,opened_by,resolution_plan,
 original_manifest_sha,revised_manifest_sha,idempotency_key,request_sha
 FROM dhf_pilot_remediation_cases WHERE return_decision_id=$1 `,decisionID).
 Scan(&rec.ID,&rec.ReturnDecisionID,&rec.OriginalSubmissionID,&rec.NewAttemptID,
  &rec.ProjectID,&rec.StageID,&rec.TemplateID,&rec.OpenedBy,&rec.ResolutionPlan,
  &rec.OriginalManifestSHA,&rec.RevisedManifestSHA,&rec.IdempotencyKey,&rec.RequestSHA)
 if errors.Is(err,pgx.ErrNoRows){return rec,ports.ErrRowMissing}
 return rec,err
}

func(r *Repository)DHFPilotPersistRemediation(ctx context.Context,rec ports.DHFPilotRemediationRecord,manifest []byte)error{
 if rec.ID==""||rec.NewAttemptID==""||rec.ReturnDecisionID==""||rec.OpenedBy==""||len(manifest)<2{
  return errors.New("incomplete DHF remediation record")
 }
 // Never re-open or overwrite the submitted source attempt. A brand-new
 // PREPARING attempt gets its own new body/hash and later submission journal.
 _,err:=r.Q.Exec(ctx,`
 INSERT INTO dhf_pilot_attempts(id,project_id,stage_id,template_id,manifest_body,manifest_sha,created_by)
 VALUES($1,$2,$3,$4,$5,$6,$7) `,
  rec.NewAttemptID,rec.ProjectID,rec.StageID,rec.TemplateID,manifest,
  rec.RevisedManifestSHA,rec.OpenedBy)
 if err!=nil{return err}
 _,err=r.Q.Exec(ctx,`
 INSERT INTO dhf_pilot_remediation_cases(id,return_decision_id,original_submission_id,
 new_attempt_id,project_id,stage_id,template_id,opened_by,resolution_plan,
 original_manifest_sha,revised_manifest_sha,idempotency_key,request_sha)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) `,
  rec.ID,rec.ReturnDecisionID,rec.OriginalSubmissionID,rec.NewAttemptID,
  rec.ProjectID,rec.StageID,rec.TemplateID,rec.OpenedBy,rec.ResolutionPlan,
  rec.OriginalManifestSHA,rec.RevisedManifestSHA,rec.IdempotencyKey,rec.RequestSHA)
 if err!=nil{return err}
 _,err=r.Q.Exec(ctx,`
 INSERT INTO dhf_pilot_remediation_events(id,case_id,kind,actor_id,request_sha)
 VALUES($1,$2,'opened',$3,$4) `,newID("dhfrev"),rec.ID,rec.OpenedBy,rec.RequestSHA)
 if err!=nil{return err}
 _,err=r.Q.Exec(ctx,`
 INSERT INTO audit_events(actor_id,event_type,target_kind,target_id,request_id,outcome,details)
 VALUES($1,'dhf.pilot.remediation.opened','dhf_remediation',$2,$3,'success',
 jsonb_build_object('returnDecisionId',$4::text,'newAttemptId',$5::text,'originalSubmissionId',$6::text)) `,
  rec.OpenedBy,rec.ID,rec.IdempotencyKey,rec.ReturnDecisionID,rec.NewAttemptID,rec.OriginalSubmissionID)
 return err
}
