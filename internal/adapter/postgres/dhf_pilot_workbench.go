package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/ports"
)

var _ ports.DHFPilotWorkbenchStore = (*Repository)(nil)

// Task listing grants no signature, version-download, or approval rights.
func (r *Repository) DHFPilotReviewTasksForActor(ctx context.Context, actorID string, limit int) ([]ports.DHFPilotWorkbenchTask,error) {
	if actorID=="" {return nil,errors.New("actor required")}
	if limit<=0 || limit>100 {limit=50}
	rows,err:=r.Q.Query(ctx, `
SELECT t.id,t.project_id,t.stage_id,t.submission_id,t.review_key,t.status,t.assigned_at,
 CASE WHEN t.stage_id='G5' AND t.review_key='__gate__'
 THEN (SELECT count(*)>0 AND count(*) FILTER(WHERE s.status<>'reviewed')=0
       FROM dhf_pilot_workbench_tasks s
       WHERE s.submission_id=t.submission_id AND s.review_key<>'__gate__')
 ELSE true END
FROM dhf_pilot_workbench_tasks t
JOIN dhf_pilot_projects p ON p.id=t.project_id AND p.state='active'
JOIN dhf_pilot_members m ON m.project_id=t.project_id AND m.user_id=t.reviewer_id
JOIN users u ON u.id=t.reviewer_id AND u.disabled_at IS NULL
JOIN dhf_pilot_submissions sub ON sub.id=t.submission_id
JOIN dhf_pilot_templates policy ON policy.id=sub.template_id AND policy.status='published'
WHERE t.reviewer_id=$1 AND t.status='pending'
ORDER BY t.assigned_at DESC,t.id DESC LIMIT $2 `,actorID,limit)
	if err!=nil{return nil,err}
	defer rows.Close()
	tasks:=make([]ports.DHFPilotWorkbenchTask,0)
	for rows.Next(){
		var task ports.DHFPilotWorkbenchTask
		if err=rows.Scan(&task.ID,&task.ProjectID,&task.StageID,&task.SubmissionID,&task.ReviewKey,&task.Status,&task.AssignedAt,&task.GateReady);err!=nil{return nil,err}
		tasks=append(tasks,task)
	}
	return tasks,rows.Err()
}
