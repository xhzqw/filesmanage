package postgres

import(
 "context"
 "errors"
 "filesmanage/internal/ports"
 "github.com/jackc/pgx/v5"
)

var _ ports.DHFPilotAttestationStore=(*Repository)(nil)

func(r *Repository)DHFPilotAttestationDecisionForSigner(ctx context.Context,taskID,actorID string)(ports.DHFPilotAttestationDecision,error){
 var value ports.DHFPilotAttestationDecision
 if taskID==""||actorID==""{return value,ports.ErrRowMissing}
 err:=r.Q.QueryRow(ctx,`
 SELECT d.id,d.task_id,d.submission_id,d.reviewer_id,d.outcome,d.comment,d.policy_sha,d.manifest_sha
 FROM dhf_pilot_review_decisions d
 JOIN dhf_pilot_workbench_tasks t ON t.id=d.task_id
 JOIN dhf_pilot_submissions s ON s.id=d.submission_id
 JOIN dhf_pilot_projects p ON p.id=s.project_id AND p.state='active'
 JOIN dhf_pilot_baselines b ON b.project_id=s.project_id AND b.stage_id=s.stage_id
   AND b.template_id=s.template_id AND b.active
 JOIN dhf_pilot_templates policy ON policy.id=s.template_id AND policy.status='published'
 JOIN dhf_pilot_members m ON m.project_id=s.project_id AND m.user_id=d.reviewer_id
 JOIN users usr ON usr.id=d.reviewer_id AND usr.disabled_at IS NULL
 WHERE d.task_id=$1 AND d.reviewer_id=$2 AND s.submitted_by<>$2
   AND t.reviewer_id=$2 AND t.status=CASE WHEN d.outcome='recommend_pass' THEN 'reviewed' ELSE 'returned' END
   AND s.policy_sha=d.policy_sha AND s.manifest_sha=d.manifest_sha
 FOR UPDATE OF t `,taskID,actorID).
 Scan(&value.DecisionID,&value.TaskID,&value.SubmissionID,&value.ReviewerID,&value.Outcome,
  &value.Comment,&value.PolicySHA,&value.ManifestSHA)
 if errors.Is(err,pgx.ErrNoRows){return value,ports.ErrRowMissing}
 return value,err
}
func(r *Repository)DHFPilotAttestationForTask(ctx context.Context,taskID string)(ports.DHFPilotAttestationRecord,error){
 var row ports.DHFPilotAttestationRecord
 err:=r.Q.QueryRow(ctx,`
 SELECT id,review_decision_id,task_id,submission_id,signer_id,outcome,
  sign_intent,policy_sha,manifest_sha,content_sha,idempotency_key,request_sha
 FROM dhf_pilot_review_attestations WHERE task_id=$1 `,taskID).
 Scan(&row.ID,&row.ReviewDecisionID,&row.TaskID,&row.SubmissionID,&row.SignerID,
  &row.Outcome,&row.SignIntent,&row.PolicySHA,&row.ManifestSHA,&row.ContentSHA,
  &row.IdempotencyKey,&row.RequestSHA)
 if errors.Is(err,pgx.ErrNoRows){return row,ports.ErrRowMissing}
 return row,err
}
func(r *Repository)DHFPilotPersistAttestation(ctx context.Context,row ports.DHFPilotAttestationRecord)error{
 if row.ID==""||row.ReviewDecisionID==""||row.TaskID==""||row.SubmissionID==""||row.SignerID==""{
  return errors.New("missing DHF authenticated review identity")
 }
 _,err:=r.Q.Exec(ctx,`
 INSERT INTO dhf_pilot_review_attestations(id,review_decision_id,task_id,submission_id,
 signer_id,outcome,sign_intent,policy_sha,manifest_sha,content_sha,idempotency_key,request_sha)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) `,
 row.ID,row.ReviewDecisionID,row.TaskID,row.SubmissionID,row.SignerID,row.Outcome,
 row.SignIntent,row.PolicySHA,row.ManifestSHA,row.ContentSHA,row.IdempotencyKey,row.RequestSHA)
 if err!=nil{return err}
 _,err=r.Q.Exec(ctx,`
 INSERT INTO audit_events(actor_id,event_type,target_kind,target_id,request_id,outcome,details)
 VALUES($1,'dhf.pilot.review_attested','dhf_review_task',$2,$3,'success',
 jsonb_build_object('attestationId',$4::text,'reviewDecisionId',$5::text,'contentSha',$6::text,
  'policySha',$7::text,'manifestSha',$8::text,'authMethod','password_reauthentication')) `,
 row.SignerID,row.TaskID,row.IdempotencyKey,row.ID,row.ReviewDecisionID,row.ContentSHA,
 row.PolicySHA,row.ManifestSHA)
 return err
}


func(r *Repository)DHFPilotRecentAttestationAuthFailures(ctx context.Context,actorID string)(int,error){
 var count int
 err:=r.Q.QueryRow(ctx,`
 SELECT count(*) FROM audit_events
 WHERE actor_id=$1 AND event_type='dhf.pilot.review_auth_denied'
   AND created_at > now()-interval '15 minutes' `,actorID).Scan(&count)
 return count,err
}
func(r *Repository)DHFPilotAuditAttestationAuthFailure(ctx context.Context,actorID,taskID string)error{
 _,err:=r.Q.Exec(ctx,`
 INSERT INTO audit_events(actor_id,event_type,target_kind,target_id,outcome,details)
 VALUES($1,'dhf.pilot.review_auth_denied','dhf_review_task',$2,'denied',
  jsonb_build_object('authentication','password_reauthentication','reason','invalid_credential')) `,
  actorID,taskID)
 return err
}
