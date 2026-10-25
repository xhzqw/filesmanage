package postgres

import(
 "context"
 "errors"
 "filesmanage/internal/ports"
)

var _ ports.DHFPilotAttestationInboxStore=(*Repository)(nil)

func(r *Repository)DHFPilotAttestationInboxForSigner(ctx context.Context,signerID string,limit int)([]ports.DHFPilotAttestationInboxRow,error){
 if signerID==""{return nil,errors.New("authenticated signer required")}
 if limit<1||limit>200{limit=100}
 rows,err:=r.Q.Query(ctx,`
 SELECT t.id,d.id,s.id,s.project_id,s.stage_id,t.review_key,
        d.outcome,d.comment,d.policy_sha,d.manifest_sha,
        (SELECT count(*) FROM dhf_pilot_review_obligations before
         LEFT JOIN dhf_pilot_review_attestations signed ON signed.task_id=before.task_id
           AND signed.outcome='recommend_pass'
         WHERE before.submission_id=s.id AND before.step_ordinal<o.step_ordinal
         AND signed.id IS NULL),
        (SELECT count(*) FROM dhf_pilot_review_obligations before
         LEFT JOIN dhf_pilot_review_attestations signed ON signed.task_id=before.task_id
           AND signed.outcome='recommend_pass'
         WHERE before.submission_id=s.id AND before.step_ordinal<o.step_ordinal
         AND signed.id IS NULL)=0
          OR (o.review_key<>'__gate__' AND EXISTS
            (SELECT 1 FROM dhf_pilot_early_interventions x WHERE x.target_task_id=t.id)),
        COALESCE(att.id,''),COALESCE(att.content_sha,'')
 FROM dhf_pilot_review_decisions d
 JOIN dhf_pilot_workbench_tasks t ON t.id=d.task_id
 JOIN dhf_pilot_review_obligations o ON o.task_id=t.id
 JOIN dhf_pilot_submissions s ON s.id=d.submission_id
 JOIN dhf_pilot_projects project ON project.id=s.project_id AND project.state='active'
 JOIN dhf_pilot_baselines baseline ON baseline.project_id=s.project_id AND baseline.stage_id=s.stage_id
  AND baseline.template_id=s.template_id AND baseline.active
 JOIN dhf_pilot_templates policy ON policy.id=s.template_id AND policy.status='published'
 JOIN dhf_pilot_members member ON member.project_id=s.project_id AND member.user_id=$1
 JOIN users user_account ON user_account.id=$1 AND user_account.disabled_at IS NULL
 LEFT JOIN dhf_pilot_review_attestations att ON att.task_id=t.id
 WHERE d.reviewer_id=$1 AND t.reviewer_id=$1 AND s.submitted_by<>$1
 ORDER BY t.assigned_at DESC LIMIT $2 `,signerID,limit)
 if err!=nil{return nil,err}
 defer rows.Close()
 result:=make([]ports.DHFPilotAttestationInboxRow,0)
 for rows.Next(){
  var item ports.DHFPilotAttestationInboxRow
  if err=rows.Scan(&item.TaskID,&item.DecisionID,&item.SubmissionID,&item.ProjectID,&item.StageID,
   &item.ReviewKey,&item.Outcome,&item.ReviewComment,&item.PolicySHA,&item.ManifestSHA,
   &item.OutstandingPrior,&item.CanAttest,&item.AttestationID,&item.ContentSHA);err!=nil{
   return nil,err
  }
  result=append(result,item)
 }
 return result,rows.Err()
}
