package postgres

import (
 "context"
 "filesmanage/internal/ports"
)

// Related records are intentionally scoped twice: only the current DHF
// project member's authored CDW tasks are returned, and the application
// independently checks the selected pinned DHF file's present preview ACL.
func (r *Repository) DHFRelatedWork(ctx context.Context, projectID, actorID string, limit int) ([]ports.DHFRelatedWork,error){
 rows,err:=r.Q.Query(ctx,`SELECT i.source_line,i.stage_no,t.id,t.title,t.state,
 COALESCE(u.display_name,w.name,''),EXISTS(
  SELECT 1 FROM cdw_deliveries d JOIN cdw_delivery_items di ON di.delivery_id=d.id
  WHERE d.task_id=t.id AND di.file_id=i.file_id AND di.sha256=i.file_sha256
 )
 FROM dhf_items i
 JOIN cdw_tasks t ON t.file_id=i.file_id AND t.created_by=$2 AND t.subject_kind='file'
 LEFT JOIN cdw_task_assignments a ON a.task_id=t.id AND a.kind='primary' AND a.ended_at IS NULL
 LEFT JOIN users u ON u.id=a.user_id
 LEFT JOIN workgroups w ON w.id=a.group_id
 WHERE i.project_id=$1 AND i.file_id IS NOT NULL
 AND EXISTS(SELECT 1 FROM dhf_projects p WHERE p.id=i.project_id AND (p.owner_id=$2 OR p.reviewer_id=$2))
 ORDER BY i.stage_no,i.source_line,t.created_at DESC,t.id DESC LIMIT $3`,projectID,actorID,limit)
 if err!=nil{return nil,err}
 defer rows.Close()
 out:=[]ports.DHFRelatedWork{}
 for rows.Next(){
  var link ports.DHFRelatedWork
  if err=rows.Scan(&link.SourceLine,&link.StageNo,&link.TaskID,&link.Title,&link.State,&link.AssigneeName,&link.ExactDeliveryMatch);err!=nil{return nil,err}
  out=append(out,link)
 }
 return out,rows.Err()
}
