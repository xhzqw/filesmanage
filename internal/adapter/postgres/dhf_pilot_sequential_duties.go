package postgres

import (
 "context"
 "errors"
 "filesmanage/internal/ports"

 "github.com/jackc/pgx/v5"
)

var _ ports.DHFPilotEarlyInterventionStore=(*Repository)(nil)
var _ ports.DHFPilotDutyReadStore=(*Repository)(nil)

func(r *Repository)DHFPilotEarlyTargetForActor(ctx context.Context,taskID,actorID string)(ports.DHFPilotEarlyTarget,error){
 var result ports.DHFPilotEarlyTarget
 if taskID==""||actorID==""{return result,ports.ErrRowMissing}
 err:=r.Q.QueryRow(ctx,`
 SELECT target.task_id,target.submission_id,target.review_key,target.step_ordinal,
        target.policy_sha,target.manifest_sha
 FROM dhf_pilot_review_obligations target
 JOIN dhf_pilot_workbench_tasks t ON t.id=target.task_id AND t.status='pending'
 JOIN dhf_pilot_workbench_tasks gate ON gate.submission_id=target.submission_id
    AND gate.review_key='__gate__' AND gate.reviewer_id=$2 AND gate.status='pending'
 JOIN dhf_pilot_submissions sub ON sub.id=target.submission_id
 JOIN dhf_pilot_projects p ON p.id=sub.project_id AND p.state='active'
 JOIN dhf_pilot_templates pol ON pol.id=sub.template_id AND pol.status='published'
 JOIN dhf_pilot_members member ON member.project_id=sub.project_id AND member.user_id=$2
 JOIN users actor ON actor.id=$2 AND actor.disabled_at IS NULL
 WHERE target.task_id=$1 AND target.step_ordinal>1 AND target.review_key<>'__gate__'
   AND sub.submitted_by<>$2 AND t.reviewer_id<>$2
   AND EXISTS (
     SELECT 1 FROM dhf_pilot_review_obligations earlier
     JOIN dhf_pilot_workbench_tasks prev ON prev.id=earlier.task_id
     WHERE earlier.submission_id=target.submission_id
       AND earlier.step_ordinal<target.step_ordinal AND prev.status<>'reviewed'
   )
 FOR UPDATE OF t `,taskID,actorID).
 Scan(&result.TaskID,&result.SubmissionID,&result.ReviewKey,&result.StepOrdinal,&result.PolicySHA,&result.ManifestSHA)
 if errors.Is(err,pgx.ErrNoRows){return result,ports.ErrRowMissing}
 return result,err
}

func(r *Repository)DHFPilotEarlyInterventionForTarget(ctx context.Context,taskID string)(ports.DHFPilotEarlyInterventionRecord,error){
 var value ports.DHFPilotEarlyInterventionRecord
 err:=r.Q.QueryRow(ctx,`
 SELECT id,target_task_id,submission_id,authorized_by,reason,idempotency_key,request_sha,policy_sha,manifest_sha
 FROM dhf_pilot_early_interventions WHERE target_task_id=$1 `,taskID).
 Scan(&value.ID,&value.TargetTaskID,&value.SubmissionID,&value.AuthorizedBy,&value.Reason,
  &value.IdempotencyKey,&value.RequestSHA,&value.PolicySHA,&value.ManifestSHA)
 if errors.Is(err,pgx.ErrNoRows){return value,ports.ErrRowMissing}
 return value,err
}

func(r *Repository)DHFPilotPersistEarlyIntervention(ctx context.Context,rec ports.DHFPilotEarlyInterventionRecord)error{
 if rec.ID==""||rec.TargetTaskID==""||rec.SubmissionID==""||rec.AuthorizedBy==""{
  return errors.New("missing DHF authorized intervention identity")
 }
 _,err:=r.Q.Exec(ctx,`
 INSERT INTO dhf_pilot_early_interventions(id,target_task_id,submission_id,authorized_by,reason,
   idempotency_key,request_sha,policy_sha,manifest_sha)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) `,rec.ID,rec.TargetTaskID,rec.SubmissionID,
  rec.AuthorizedBy,rec.Reason,rec.IdempotencyKey,rec.RequestSHA,rec.PolicySHA,rec.ManifestSHA)
 if err!=nil{return err}
 _,err=r.Q.Exec(ctx,`
 INSERT INTO audit_events(actor_id,event_type,target_kind,target_id,request_id,outcome,details)
 VALUES($1,'dhf.pilot.early_intervention','dhf_review_task',$2,$3,'success',
 jsonb_build_object('interventionId',$4::text,'submissionId',$5::text,'reviewKey',$6::text)) `,
  rec.AuthorizedBy,rec.TargetTaskID,rec.IdempotencyKey,rec.ID,rec.SubmissionID,"early_review")
 return err
}

func(r *Repository)DHFPilotDutiesForActor(ctx context.Context,actorID string,limit int)([]ports.DHFPilotDutySnapshot,error){
 if actorID==""{return nil,errors.New("authenticated DHF reviewer required")}
 if limit<1||limit>200{limit=100}
 rows,err:=r.Q.Query(ctx,`
 SELECT o.submission_id,s.project_id,s.stage_id,o.task_id,o.review_key,
 o.step_ordinal,o.reviewer_id,t.status,(i.id IS NOT NULL),
 COALESCE(i.reason,''),
 (o.review_key<>'__gate__' AND o.step_ordinal>1
  AND t.status='pending' AND gate.reviewer_id=$1 AND gate.status='pending'
  AND i.id IS NULL
  AND EXISTS (SELECT 1 FROM dhf_pilot_review_obligations prior
    JOIN dhf_pilot_workbench_tasks prev ON prev.id=prior.task_id
    WHERE prior.submission_id=o.submission_id AND prior.step_ordinal<o.step_ordinal
      AND prev.status<>'reviewed')),
 (SELECT count(*) FROM dhf_pilot_review_obligations prior
  JOIN dhf_pilot_workbench_tasks prev ON prev.id=prior.task_id
  WHERE prior.submission_id=o.submission_id AND prior.step_ordinal<o.step_ordinal
    AND prev.status<>'reviewed')
 FROM dhf_pilot_review_obligations o
 JOIN dhf_pilot_submissions s ON s.id=o.submission_id
 JOIN dhf_pilot_workbench_tasks t ON t.id=o.task_id
 JOIN dhf_pilot_workbench_tasks gate ON gate.submission_id=o.submission_id AND gate.review_key='__gate__'
 JOIN dhf_pilot_projects p ON p.id=s.project_id AND p.state='active'
 JOIN dhf_pilot_members member ON member.project_id=s.project_id AND member.user_id=$1
 JOIN users actor ON actor.id=$1 AND actor.disabled_at IS NULL
 LEFT JOIN dhf_pilot_early_interventions i ON i.target_task_id=o.task_id
 WHERE EXISTS(SELECT 1 FROM dhf_pilot_workbench_tasks mine
    WHERE mine.submission_id=o.submission_id AND mine.reviewer_id=$1)
 ORDER BY s.submitted_at DESC,o.submission_id,o.step_ordinal LIMIT $2 `,actorID,limit)
 if err!=nil{return nil,err}
 defer rows.Close()
 out:=make([]ports.DHFPilotDutySnapshot,0)
 for rows.Next(){
  var x ports.DHFPilotDutySnapshot
  if err=rows.Scan(&x.SubmissionID,&x.ProjectID,&x.StageID,&x.TaskID,&x.ReviewKey,
   &x.StepOrdinal,&x.ReviewerID,&x.Status,&x.EarlyIntervention,
   &x.InterventionReason,&x.CanAuthorizeEarly,&x.OutstandingPrior);err!=nil{return nil,err}
  out=append(out,x)
 }
 return out,rows.Err()
}
