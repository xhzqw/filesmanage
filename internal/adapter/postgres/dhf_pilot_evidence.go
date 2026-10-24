package postgres

import (
 "context"
 "errors"
 "filesmanage/internal/ports"
)

var _ ports.DHFPilotEvidenceStore = (*Repository)(nil)

// Task membership grants access to the private pin INDEX only; the
// application separately checks preview permission on every referenced file.
func (r *Repository) DHFPilotEvidenceForReviewer(ctx context.Context,taskID,actorID string)([]ports.DHFPilotEvidencePin,error){
 if taskID==""||actorID==""{return nil,ports.ErrRowMissing}
 rows,err:=r.Q.Query(ctx,`
 SELECT e.requirement_id,e.file_id,e.version_seq,e.blob_id,e.sha256
 FROM dhf_pilot_workbench_tasks task
 JOIN dhf_pilot_submissions s ON s.id=task.submission_id
 JOIN dhf_pilot_projects p ON p.id=task.project_id AND p.state='active'
 JOIN dhf_pilot_members m ON m.project_id=task.project_id AND m.user_id=task.reviewer_id
 JOIN users u ON u.id=task.reviewer_id AND u.disabled_at IS NULL
 JOIN dhf_pilot_templates template ON template.id=s.template_id AND template.status='published'
 JOIN dhf_pilot_submission_evidence e ON e.submission_id=s.id
 WHERE task.id=$1 AND task.reviewer_id=$2 AND s.submitted_by<>$2
 ORDER BY e.requirement_id LIMIT 1025 `,taskID,actorID)
 if err!=nil{return nil,err}
 defer rows.Close()
 out:=make([]ports.DHFPilotEvidencePin,0)
 for rows.Next(){
  var pin ports.DHFPilotEvidencePin
  if err=rows.Scan(&pin.RequirementID,&pin.FileID,&pin.VersionSeq,&pin.BlobID,&pin.Sha256);err!=nil{return nil,err}
  out=append(out,pin)
 }
 if err=rows.Err();err!=nil{return nil,err}
 if len(out)>1024{return nil,errors.New("DHF evidence exceeds bounded task size")}
 // Distinguish absent task from one with intentionally zero evidence.
 var active bool
 if err=r.Q.QueryRow(ctx,`
 SELECT EXISTS(
 SELECT 1 FROM dhf_pilot_workbench_tasks t
 JOIN dhf_pilot_submissions s ON s.id=t.submission_id
 JOIN dhf_pilot_projects p ON p.id=t.project_id AND p.state='active'
 JOIN dhf_pilot_members m ON m.project_id=t.project_id AND m.user_id=t.reviewer_id
 JOIN users u ON u.id=t.reviewer_id AND u.disabled_at IS NULL
 JOIN dhf_pilot_templates pol ON pol.id=s.template_id AND pol.status='published'
 WHERE t.id=$1 AND t.reviewer_id=$2 AND s.submitted_by<>$2) `,taskID,actorID).Scan(&active);err!=nil{return nil,err}
 if !active{return nil,ports.ErrRowMissing}
 return out,nil
}
