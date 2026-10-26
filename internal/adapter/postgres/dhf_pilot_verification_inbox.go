package postgres

import(
 "context"
 "errors"
 "filesmanage/internal/ports"
)
var _ ports.DHFPilotVerificationInboxStore=(*Repository)(nil)

// Original return reviewer only; the new submitter's case is never visible
// through an arbitrary guessed case ID or by administrator membership alone.
func(r *Repository)DHFPilotVerificationCasesForReviewer(ctx context.Context,actorID string,limit int)([]ports.DHFPilotVerificationInboxRow,error){
 if actorID==""{return nil,errors.New("missing original reviewer actor")}
 if limit<1||limit>100{limit=50}
 rows,err:=r.Q.Query(ctx,`
 SELECT c.id,c.return_decision_id,c.project_id,c.stage_id,c.original_submission_id,
 COALESCE(revised.id,''),c.original_manifest_sha,c.revised_manifest_sha,
 old_dec.comment,c.resolution_plan,attempt.state,
 (origin_att.id IS NOT NULL AND revised.id IS NOT NULL
  AND EXISTS(SELECT 1 FROM dhf_pilot_review_obligations duty WHERE duty.submission_id=revised.id)
  AND NOT EXISTS(
   SELECT 1 FROM dhf_pilot_review_obligations duty
   JOIN dhf_pilot_workbench_tasks t ON t.id=duty.task_id
   LEFT JOIN dhf_pilot_review_decisions d ON d.task_id=t.id
   LEFT JOIN dhf_pilot_review_attestations att ON att.task_id=t.id
   WHERE duty.submission_id=revised.id AND (
    t.status<>'reviewed' OR d.outcome IS DISTINCT FROM 'recommend_pass'
    OR att.outcome IS DISTINCT FROM 'recommend_pass'
    OR d.id IS DISTINCT FROM att.review_decision_id
   )
  )),COALESCE(v.id,'')
 FROM dhf_pilot_remediation_cases c
 JOIN dhf_pilot_review_decisions old_dec ON old_dec.id=c.return_decision_id
   AND old_dec.outcome='recommend_return' AND old_dec.reviewer_id=$1
 JOIN dhf_pilot_attempts attempt ON attempt.id=c.new_attempt_id
 JOIN dhf_pilot_projects project ON project.id=c.project_id AND project.state='active'
 JOIN dhf_pilot_baselines baseline ON baseline.project_id=c.project_id
  AND baseline.stage_id=c.stage_id AND baseline.template_id=c.template_id AND baseline.active
 JOIN dhf_pilot_members member ON member.project_id=c.project_id AND member.user_id=$1
 JOIN users actor ON actor.id=$1 AND actor.disabled_at IS NULL
 LEFT JOIN dhf_pilot_review_attestations origin_att ON origin_att.review_decision_id=old_dec.id
   AND origin_att.signer_id=$1 AND origin_att.outcome='recommend_return'
 LEFT JOIN dhf_pilot_submissions revised ON revised.attempt_id=c.new_attempt_id
   AND revised.manifest_sha=c.revised_manifest_sha
 LEFT JOIN dhf_pilot_remediation_verifications v ON v.case_id=c.id
 ORDER BY c.opened_at DESC,c.id DESC LIMIT $2`,actorID,limit)
 if err!=nil{return nil,err}
 defer rows.Close()
 out:=make([]ports.DHFPilotVerificationInboxRow,0)
 for rows.Next(){
  var item ports.DHFPilotVerificationInboxRow
  if err=rows.Scan(&item.CaseID,&item.ReturnDecisionID,&item.ProjectID,&item.StageID,
    &item.OriginalSubmissionID,&item.RevisedSubmissionID,&item.OriginalManifestSHA,
    &item.RevisedManifestSHA,&item.ReturnReason,&item.ResolutionPlan,
    &item.NewAttemptState,&item.ReadyToVerify,&item.VerificationID);err!=nil{return nil,err}
  out=append(out,item)
 }
 return out,rows.Err()
}
