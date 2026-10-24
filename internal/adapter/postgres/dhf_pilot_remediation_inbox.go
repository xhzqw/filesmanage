package postgres

import (
 "context"
 "errors"
 "filesmanage/internal/ports"
)

var _ ports.DHFPilotReturnInboxStore=(*Repository)(nil)

func(r *Repository)DHFPilotReturnsForAuthor(ctx context.Context,actorID string,limit int)([]ports.DHFPilotReturnInboxRow,error){
 if actorID==""{return nil,errors.New("authenticated actor required")}
 if limit<1||limit>100{limit=50}
 rows,err:=r.Q.Query(ctx,`
 SELECT d.id,t.review_key,s.project_id,s.stage_id,s.id,src.manifest_body,
        src.manifest_sha,d.comment,d.decided_at,
        COALESCE(c.id,''),COALESCE(c.new_attempt_id,''),COALESCE(revised.state,''),
        (p.state='active' AND m.can_prepare AND baseline.active
          AND baseline.template_id=s.template_id AND tmpl.status='published')
 FROM dhf_pilot_review_decisions d
 JOIN dhf_pilot_workbench_tasks t ON t.id=d.task_id AND t.status='returned'
 JOIN dhf_pilot_submissions s ON s.id=d.submission_id
 JOIN dhf_pilot_attempts src ON src.id=s.attempt_id
 JOIN users u ON u.id=s.submitted_by AND u.disabled_at IS NULL
 JOIN dhf_pilot_projects p ON p.id=s.project_id
 JOIN dhf_pilot_members m ON m.project_id=s.project_id AND m.user_id=s.submitted_by
 JOIN dhf_pilot_baselines baseline ON baseline.project_id=s.project_id AND baseline.stage_id=s.stage_id
 JOIN dhf_pilot_templates tmpl ON tmpl.id=s.template_id
 LEFT JOIN dhf_pilot_remediation_cases c ON c.original_submission_id=s.id
 LEFT JOIN dhf_pilot_attempts revised ON revised.id=c.new_attempt_id
 WHERE s.submitted_by=$1 AND d.outcome='recommend_return'
 ORDER BY d.decided_at DESC,d.id DESC LIMIT $2 `,actorID,limit)
 if err!=nil{return nil,err}
 defer rows.Close()
 result:=make([]ports.DHFPilotReturnInboxRow,0)
 for rows.Next(){
  var row ports.DHFPilotReturnInboxRow
  if err=rows.Scan(&row.DecisionID,&row.ReviewKey,&row.ProjectID,&row.StageID,
    &row.OriginalSubmissionID,&row.OriginalManifest,&row.OriginalManifestSHA,
    &row.Reason,&row.DecidedAt,&row.CaseID,&row.NewAttemptID,
    &row.NewAttemptState,&row.CanPrepare);err!=nil{return nil,err}
  result=append(result,row)
 }
 return result,rows.Err()
}
