package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/ports"

	"github.com/jackc/pgx/v5"
)

var _ ports.DHFPilotRecommendationStore = (*Repository)(nil)

// Lock only the currently assigned review task. The policy, identity and
// project eligibility are fetched from the same SERIALIZABLE transaction.
func (r *Repository) DHFPilotReviewTaskForActor(ctx context.Context,taskID,actorID string)(ports.DHFPilotRecommendationTask,error){
	var task ports.DHFPilotRecommendationTask
	if taskID=="" || actorID==""{return task,ports.ErrRowMissing}
	err:=r.Q.QueryRow(ctx,`
SELECT t.id,t.submission_id,t.project_id,t.stage_id,t.review_key,t.status,t.reviewer_id,
       sub.policy_sha,sub.manifest_sha
FROM dhf_pilot_workbench_tasks t
JOIN dhf_pilot_submissions sub ON sub.id=t.submission_id
JOIN dhf_pilot_projects p ON p.id=t.project_id AND p.state='active'
JOIN dhf_pilot_templates template ON template.id=sub.template_id AND template.status='published'
JOIN dhf_pilot_members m ON m.project_id=t.project_id AND m.user_id=t.reviewer_id
JOIN users u ON u.id=m.user_id AND u.disabled_at IS NULL
WHERE t.id=$1 AND t.reviewer_id=$2 AND sub.submitted_by<>$2
FOR UPDATE OF t `,taskID,actorID).Scan(&task.ID,&task.SubmissionID,&task.ProjectID,
		&task.StageID,&task.ReviewKey,&task.Status,&task.ReviewerID,
		&task.PolicySHA,&task.ManifestSHA)
	if errors.Is(err,pgx.ErrNoRows){return task,ports.ErrRowMissing}
	return task,err
}

func (r *Repository) DHFPilotRecommendationForTask(ctx context.Context,taskID string)(ports.DHFPilotRecommendationRecord,error){
	var rec ports.DHFPilotRecommendationRecord
	err:=r.Q.QueryRow(ctx,`
SELECT id,task_id,submission_id,reviewer_id,outcome,comment,idempotency_key,request_sha,policy_sha,manifest_sha
FROM dhf_pilot_review_decisions WHERE task_id=$1 `,taskID).
		Scan(&rec.ID,&rec.TaskID,&rec.SubmissionID,&rec.ReviewerID,&rec.Outcome,
			&rec.Comment,&rec.IdempotencyKey,&rec.RequestSHA,&rec.PolicySHA,&rec.ManifestSHA)
	if errors.Is(err,pgx.ErrNoRows){return rec,ports.ErrRowMissing}
	return rec,err
}

func (r *Repository) DHFPilotPersistRecommendation(ctx context.Context,rec ports.DHFPilotRecommendationRecord) error{
	if rec.TaskID=="" || rec.SubmissionID=="" || rec.ReviewerID=="" || rec.ID==""{
		return errors.New("incomplete DHF recommendation identity")
	}
	_,err:=r.Q.Exec(ctx,`
INSERT INTO dhf_pilot_review_decisions(
 id,task_id,submission_id,reviewer_id,outcome,comment,idempotency_key,
 request_sha,policy_sha,manifest_sha)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) `,
		rec.ID,rec.TaskID,rec.SubmissionID,rec.ReviewerID,rec.Outcome,rec.Comment,
		rec.IdempotencyKey,rec.RequestSHA,rec.PolicySHA,rec.ManifestSHA)
	if err!=nil{return err}
	next:="reviewed"
	if rec.Outcome=="recommend_return"{next="returned"}
	tag,err:=r.Q.Exec(ctx,"UPDATE dhf_pilot_workbench_tasks SET status=$2 WHERE id=$1 AND status='pending' AND reviewer_id=$3",
		rec.TaskID,next,rec.ReviewerID)
	if err!=nil{return err}
	if tag.RowsAffected()!=1{return errors.New("DHF reviewer task concurrently decided")}
	_,err=r.Q.Exec(ctx,`
INSERT INTO audit_events(actor_id,event_type,target_kind,target_id,request_id,outcome,details)
VALUES($1,'dhf.pilot.recommendation','dhf_review_task',$2,$3,'success',
 jsonb_build_object('decisionId',$4::text,'recommendation',$5::text,'submissionId',$6::text)) `,
		rec.ReviewerID,rec.TaskID,rec.IdempotencyKey,rec.ID,rec.Outcome,rec.SubmissionID)
	return err
}
