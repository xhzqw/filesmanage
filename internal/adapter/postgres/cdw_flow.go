package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"fmt"
	"github.com/jackc/pgx/v5"
)

// CDWInitiatedFlow is an author-scoped read projection; it never advances
// workflow state. Every downstream relation follows exact delivery lineage.
func (r *Repository) CDWInitiatedFlow(ctx context.Context, actor, taskID string) (string, ports.CDWFlowSnapshot, error) {
	var fileID, rootID string
	err := r.Q.QueryRow(ctx, `SELECT file_id,root_id FROM cdw_tasks WHERE id=$1 AND created_by=$2 AND subject_kind='file'`, taskID, actor).Scan(&fileID, &rootID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ports.CDWFlowSnapshot{}, domain.ErrNotFound
	}
	if err != nil {
		return "", ports.CDWFlowSnapshot{}, err
	}
	result := ports.CDWFlowSnapshot{TaskID: taskID, RootID: rootID, Works: []ports.CDWFlowWork{}, Milestones: []ports.CDWFlowMilestone{}}
	rows, err := r.Q.Query(ctx, `WITH RECURSIVE descendants AS (
 SELECT t.id,t.parent_id,t.title,t.state,t.round_no,t.created_by,t.created_at,0 AS depth
 FROM cdw_tasks t WHERE t.id=$1
 UNION ALL
 SELECT t.id,t.parent_id,t.title,t.state,t.round_no,t.created_by,t.created_at,d.depth+1
 FROM cdw_tasks t JOIN descendants d ON t.parent_id=d.id WHERE d.depth<32
 ) SELECT d.id,COALESCE(d.parent_id,''),d.title,d.state,d.round_no,
 COALESCE(u.display_name,wg.name,''),COALESCE(au.display_name,'')
 FROM descendants d JOIN users au ON au.id=d.created_by
 LEFT JOIN cdw_task_assignments a ON a.task_id=d.id AND a.kind='primary' AND a.ended_at IS NULL
 LEFT JOIN users u ON u.id=a.user_id
 LEFT JOIN workgroups wg ON wg.id=a.group_id
 ORDER BY d.depth,d.created_at,d.id LIMIT 101`, taskID)
	if err != nil {
		return "", ports.CDWFlowSnapshot{}, err
	}
	for rows.Next() {
		var w ports.CDWFlowWork
		if err = rows.Scan(&w.ID, &w.ParentID, &w.Title, &w.State, &w.Round, &w.ResponsibleName, &w.CreatedByName); err != nil {
			break
		}
		if len(result.Works) >= 100 {
			result.Truncated = true
			break
		}
		result.Works = append(result.Works, w)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return "", ports.CDWFlowSnapshot{}, err
	}
	taskIDs := make([]string, 0, len(result.Works))
	for _, w := range result.Works {
		taskIDs = append(taskIDs, w.ID)
	}
	// A stage is returned ONLY if its source row exists. No blank stages are
	// emitted and no equivalence between delivery acceptance and approval exists.
	steps, err := r.Q.Query(ctx, `WITH deliveries AS (
 SELECT d.id,d.task_id,d.round_no,d.submitted_by,d.submitted_at FROM cdw_deliveries d WHERE d.task_id=ANY($1::text[])
 ), subjects AS (
 SELECT s.id,s.delivery_id,d.task_id FROM cdw_approval_subjects s JOIN deliveries d ON d.id=s.delivery_id
 WHERE s.source_kind='delivery'
 ), approvals AS (
 SELECT a.id,a.subject_id,s.task_id,a.state,a.requested_by,a.requested_at,a.completed_at
 FROM cdw_formal_approval_instances a JOIN subjects s ON s.id=a.subject_id
 ), candidates AS (
 SELECT c.id,c.subject_id,s.task_id,c.approved_at FROM cdw_approved_candidates c JOIN subjects s ON s.id=c.subject_id
 ), releases AS (
 SELECT r.id,c.task_id,r.state,r.prepared_at,r.prepared_by,r.actual_effective_at,r.file_id
 FROM cdw_controlled_releases r JOIN candidates c ON c.id=r.approved_candidate_id
 ), plans AS (
 SELECT DISTINCT p.id,r.task_id,p.state,p.created_at,p.created_by
 FROM cdw_distribution_plans p JOIN cdw_distribution_plan_items pi ON pi.plan_id=p.id
 JOIN releases r ON r.id=pi.release_id
 ), batches AS (
 SELECT DISTINCT b.id,b.plan_id,p.task_id,b.state,b.dispatched_at,b.dispatched_by,p.created_at
 FROM cdw_distribution_batches b JOIN plans p ON p.id=b.plan_id
 )
 SELECT step,reference,state,round_no,actor_name,recorded_at,detail,source_task_id
 FROM (
 SELECT 1 AS rank,'delivery'::text AS step,d.id AS reference,'submitted'::text AS state,d.round_no,
 COALESCE(u.display_name,'') AS actor_name,d.submitted_at AS recorded_at,'冻结交付稿'::text AS detail,d.task_id AS source_task_id
 FROM deliveries d LEFT JOIN users u ON u.id=d.submitted_by
 UNION ALL
 SELECT 2,'review',g.id,g.state,d.round_no,COALESCE(u.display_name,''),
 COALESCE(dec.decided_at,d.submitted_at),'逐级交付验收',d.task_id
 FROM cdw_review_gates g JOIN deliveries d ON d.id=g.delivery_id
 LEFT JOIN cdw_review_decisions dec ON dec.gate_id=g.id AND dec.is_final
 LEFT JOIN users u ON u.id=COALESCE(dec.actor_id,g.responsible_user_id)
 UNION ALL
 SELECT 3,'formal',a.id,a.state,0,COALESCE(u.display_name,''),
 COALESCE(a.completed_at,a.requested_at),'独立正式审批',a.task_id
 FROM approvals a LEFT JOIN users u ON u.id=a.requested_by
 UNION ALL
 SELECT 4,'release',r.id,r.state,0,COALESCE(u.display_name,''),
 r.prepared_at,'受控发行版本',r.task_id
 FROM releases r LEFT JOIN users u ON u.id=r.prepared_by
 UNION ALL
 SELECT 5,'plan',p.id,p.state,0,COALESCE(u.display_name,''),
 p.created_at,'分发范围计划',p.task_id
 FROM plans p LEFT JOIN users u ON u.id=p.created_by
 UNION ALL
 SELECT 6,'dispatch',b.id,b.state,0,COALESCE(u.display_name,''),
 COALESCE(b.dispatched_at,b.created_at),'部门分发批次',b.task_id
 FROM batches b LEFT JOIN users u ON u.id=b.dispatched_by
 UNION ALL
 SELECT 9,'effective',r.id,'active',0,''::text,ep.activated_at,'当前生效指针',r.task_id
 FROM releases r JOIN cdw_effective_pointers ep ON ep.file_id=r.file_id AND ep.release_id=r.id AND ep.state='active'
 ) events ORDER BY rank,recorded_at,reference,source_task_id`, taskIDs)
	if err != nil {
		return "", ports.CDWFlowSnapshot{}, err
	}
	for steps.Next() {
		var m ports.CDWFlowMilestone
		if err = steps.Scan(&m.Kind, &m.Reference, &m.State, &m.Round, &m.ActorName, &m.RecordedAt, &m.Detail, &m.TaskID); err != nil {
			break
		}
		result.Milestones = append(result.Milestones, m)
	}
	if err == nil {
		err = steps.Err()
	}
	steps.Close()
	if err != nil {
		return "", ports.CDWFlowSnapshot{}, err
	}
	// Counts are scoped to the exact approved release artifact inside each
	// dispatch batch. A receipt needs its current receipt head AND that item's
	// immutable receipt evidence; a completed reading is not inferred from a
	// department receipt or an old withdrawn batch.
	counts, err := r.Q.Query(ctx, `WITH deliveries AS (
 SELECT id,task_id FROM cdw_deliveries WHERE task_id=ANY($1::text[])
 ), subjects AS (
 SELECT s.id,d.task_id FROM cdw_approval_subjects s JOIN deliveries d ON d.id=s.delivery_id WHERE s.source_kind='delivery'
 ), releases AS (
 SELECT r.id,s.task_id FROM cdw_controlled_releases r
 JOIN cdw_approved_candidates c ON c.id=r.approved_candidate_id
 JOIN subjects s ON s.id=c.subject_id
 ), items AS (
 SELECT bi.batch_id,bi.id AS batch_item_id,r.task_id FROM cdw_distribution_batch_items bi JOIN releases r ON r.id=bi.release_id
 ), targets AS (
 SELECT i.batch_id,i.batch_item_id,i.task_id,req.target_id,req.receipt_required
 FROM items i JOIN cdw_target_item_requirements req ON req.batch_item_id=i.batch_item_id
 JOIN cdw_distribution_targets t ON t.id=req.target_id AND t.validity_state='active'
 )
 SELECT batch_id,task_id,receipt_total,receipt_ok,reading_total,reading_ok
 FROM (
 SELECT t.batch_id,t.task_id,COUNT(DISTINCT t.target_id) FILTER (WHERE t.receipt_required) AS receipt_total,
 COUNT(DISTINCT t.target_id) FILTER (WHERE t.receipt_required AND ri.receipt_id IS NOT NULL) AS receipt_ok,
 COUNT(DISTINCT ra.id) FILTER (WHERE ra.required) AS reading_total,
 COUNT(DISTINCT ra.id) FILTER (WHERE ra.required AND ra.state='confirmed') AS reading_ok
 FROM targets t
 LEFT JOIN cdw_target_receipt_heads h ON h.target_id=t.target_id
 LEFT JOIN cdw_receipt_items ri ON ri.receipt_id=h.current_receipt_id AND ri.batch_item_id=t.batch_item_id
 LEFT JOIN cdw_reading_assignments ra ON ra.target_id=t.target_id AND ra.batch_item_id=t.batch_item_id
 GROUP BY t.batch_id,t.task_id
 ) progress ORDER BY batch_id,task_id`, taskIDs)
	if err != nil {
		return "", ports.CDWFlowSnapshot{}, err
	}
	for counts.Next() {
		var batchID, sourceTaskID string
		var rt, ro, pt, po int64
		if err = counts.Scan(&batchID, &sourceTaskID, &rt, &ro, &pt, &po); err != nil {
			break
		}
		var recordedAt ports.CDWFlowMilestone
		for _, stage := range result.Milestones {
			if stage.Kind == "dispatch" && stage.Reference == batchID && stage.TaskID == sourceTaskID {
				recordedAt = stage
				break
			}
		}
		if recordedAt.RecordedAt.IsZero() {
			continue
		}
		if rt > 0 {
			state := "partial"
			if ro == rt {
				state = "complete"
			}
			result.Milestones = append(result.Milestones, ports.CDWFlowMilestone{Kind: "receipt", TaskID: sourceTaskID, Reference: batchID, State: state, RecordedAt: recordedAt.RecordedAt, Detail: fmt.Sprintf("部门签收 %d/%d", ro, rt)})
		}
		if pt > 0 {
			state := "partial"
			if po == pt {
				state = "complete"
			}
			result.Milestones = append(result.Milestones, ports.CDWFlowMilestone{Kind: "reading", TaskID: sourceTaskID, Reference: batchID, State: state, RecordedAt: recordedAt.RecordedAt, Detail: fmt.Sprintf("人员阅读确认 %d/%d", po, pt)})
		}
	}
	if err == nil {
		err = counts.Err()
	}
	counts.Close()
	if err != nil {
		return "", ports.CDWFlowSnapshot{}, err
	}
	return fileID, result, nil
}
