package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

func (r *Repository) CDWReviewEvent(ctx context.Context, actor, kind, gateID, requestID string, details map[string]any) error {
	if requestID == "" {
		return domain.ErrInvalidInput
	}
	raw, err := json.Marshal(details)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_domain_events(aggregate_kind,aggregate_id,event_kind,actor_id,request_id,details)
 VALUES('review_gate',$1,$2,$3,$4,$5)`, gateID, kind, actor, requestID, string(raw))
	if err != nil {
		return err
	}
	digest := sha256.Sum256([]byte(actor + "|" + kind + "|" + gateID + "|" + requestID))
	_, err = r.Q.Exec(ctx, `INSERT INTO outbox_jobs(id,kind,payload)
 VALUES($1,'cdw.review.changed',$2)`, "cdw_evt_"+hex.EncodeToString(digest[:]), string(raw))
	return err
}
func scanCDWReview(row rowScanner) (ports.CDWReviewGate, error) {
	var g ports.CDWReviewGate
	err := row.Scan(&g.ID, &g.DeliveryID, &g.TaskID, &g.TaskTitle, &g.FileID, &g.SubmittedBy, &g.ReviewerID, &g.BranchRevisionID, &g.SHA256, &g.State, &g.Revision, &g.Round, &g.Substitutable, &g.OverrideGrantID, &g.ReviewMode)
	return g, err
}

const cdwReviewSelect = `SELECT g.id,g.delivery_id,d.task_id,t.title,i.file_id,d.submitted_by,
 g.responsible_user_id,i.branch_revision_id,i.sha256,g.state,g.revision,g.round_no,
 g.substitutable,''::text,'direct'::text
 FROM cdw_review_gates g JOIN cdw_deliveries d ON d.id=g.delivery_id
 JOIN cdw_tasks t ON t.id=d.task_id JOIN cdw_delivery_items i ON i.delivery_id=d.id AND i.ordinal=1`

func (r *Repository) CDWReviewInbox(ctx context.Context, actor string, limit int) ([]ports.CDWReviewGate, error) {
	rows, err := r.Q.Query(ctx, cdwReviewSelect+` WHERE (g.responsible_user_id=$1 OR EXISTS (
 SELECT 1 FROM cdw_override_grants gr JOIN cdw_workflow_template_versions tv ON tv.id=t.template_version_id
 WHERE gr.gate_id=g.id AND gr.actor_id=$1 AND gr.granted_by=g.responsible_user_id
 AND gr.task_id=d.task_id AND gr.revoked_at IS NULL AND gr.valid_from<=now() AND gr.expires_at>now()
 AND 'substitute_review_gate'=ANY(gr.actions) AND g.substitutable
 AND tv.lifecycle='published' AND tv.role_policy->>'allowOverrideReview'='true'))
 AND g.state='awaiting' AND t.state='submitted' ORDER BY d.submitted_at DESC,g.id DESC LIMIT $2`, actor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []ports.CDWReviewGate{}
	for rows.Next() {
		var g ports.CDWReviewGate
		if err = rows.Scan(&g.ID, &g.DeliveryID, &g.TaskID, &g.TaskTitle, &g.FileID, &g.SubmittedBy, &g.ReviewerID, &g.BranchRevisionID, &g.SHA256, &g.State, &g.Revision, &g.Round, &g.Substitutable, &g.OverrideGrantID, &g.ReviewMode); err != nil {
			return nil, err
		}
		result = append(result, g)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	for i := range result {
		if result[i].ReviewerID != actor {
			grant, err := r.CDWReviewAccess(ctx, result[i].ID, actor)
			if err != nil {
				return nil, err
			}
			result[i].OverrideGrantID = grant
			result[i].ReviewMode = "delegated"
		}
	}
	return result, nil
}
func (r *Repository) CDWReviewBlobSource(ctx context.Context, gateID string) (ports.CDWBranchSource, error) {
	var src ports.CDWBranchSource
	err := r.Q.QueryRow(ctx, `SELECT bl.storage_key,f.name,bl.size_bytes FROM cdw_review_gates g
 JOIN cdw_deliveries d ON d.id=g.delivery_id JOIN cdw_delivery_items i ON i.delivery_id=d.id AND i.ordinal=1
 JOIN blobs bl ON bl.id=i.blob_id JOIN files f ON f.id=i.file_id
 WHERE g.id=$1 AND bl.state='ready'`, gateID).Scan(&src.StorageKey, &src.Name, &src.SizeBytes)
	if errors.Is(err, pgx.ErrNoRows) {
		return src, domain.ErrNotFound
	}
	return src, err
}
func (r *Repository) CDWReviewByID(ctx context.Context, id string) (ports.CDWReviewGate, error) {
	g, err := scanCDWReview(r.Q.QueryRow(ctx, cdwReviewSelect+` WHERE g.id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return g, domain.ErrNotFound
	}
	return g, err
}
func (r *Repository) CDWDecideReview(ctx context.Context, gateID, actor string, expected int64, decision, reason, decisionID, orderID, overrideGrantID string) (ports.CDWReviewDecisionResult, error) {
	var result ports.CDWReviewDecisionResult
	// Lock task before gate so round transitions and decisions are serialized.
	var taskID string
	err := r.Q.QueryRow(ctx, `SELECT d.task_id FROM cdw_review_gates g JOIN cdw_deliveries d ON d.id=g.delivery_id WHERE g.id=$1`, gateID).Scan(&taskID)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, domain.ErrNotFound
	}
	if err != nil {
		return result, err
	}
	var taskState string
	var taskRound int
	err = r.Q.QueryRow(ctx, `SELECT state,round_no FROM cdw_tasks WHERE id=$1 FOR UPDATE`, taskID).Scan(&taskState, &taskRound)
	if err != nil {
		return result, err
	}
	var state, reviewer, deliveryID string
	var rev int64
	var round int
	err = r.Q.QueryRow(ctx, `SELECT state,responsible_user_id,delivery_id,revision,round_no
 FROM cdw_review_gates WHERE id=$1 FOR UPDATE`, gateID).Scan(&state, &reviewer, &deliveryID, &rev, &round)
	if err != nil {
		return result, err
	}
	if (actor == reviewer && overrideGrantID != "") || (actor != reviewer && overrideGrantID == "") {
		return result, domain.ErrForbidden
	}
	if _, err = r.CDWActiveRecipients(ctx, ports.CDWAssignmentTarget{Kind: "user", ID: actor}); err != nil {
		return result, err
	}
	if expected != rev || state != "awaiting" || taskState != "submitted" || round != taskRound {
		return result, domain.ErrVersionConflict
	}
	if decision != "accept" && decision != "return" {
		return result, domain.ErrInvalidInput
	}
	if decision == "return" && reason == "" {
		return result, domain.ErrInvalidInput
	}
	if err = r.cdwVerifyDirectReviewer(ctx, taskID, reviewer); err != nil {
		return result, err
	}
	if actor != reviewer {
		var grantedBy, grantee, scope, scopeGate string
		var valid bool
		err = r.Q.QueryRow(ctx, `SELECT granted_by,actor_id,task_id,gate_id,
	 (revoked_at IS NULL AND valid_from<=now() AND expires_at>now()
	 AND 'substitute_review_gate'=ANY(actions)) FROM cdw_override_grants
	 WHERE id=$1 FOR UPDATE`, overrideGrantID).Scan(&grantedBy, &grantee, &scope, &scopeGate, &valid)
		if errors.Is(err, pgx.ErrNoRows) {
			return result, domain.ErrForbidden
		}
		if err != nil {
			return result, err
		}
		if !valid || grantedBy != reviewer || grantee != actor || scope != taskID || scopeGate != gateID {
			return result, domain.ErrForbidden
		}
		var eligible bool
		err = r.Q.QueryRow(ctx, `WITH RECURSIVE ancestors AS (
	 SELECT t.parent_id AS parent_id,0 depth FROM cdw_tasks t WHERE id=$1
	 UNION ALL SELECT t.parent_id,a.depth+1 FROM cdw_tasks t JOIN ancestors a ON t.id=a.parent_id WHERE a.parent_id IS NOT NULL
	 ) SELECT EXISTS(SELECT 1 FROM ancestors a JOIN cdw_task_assignments ass ON ass.task_id=a.parent_id
	 WHERE a.depth>=1 AND ass.kind='primary' AND ass.ended_at IS NULL
	 AND ass.accepted_at IS NOT NULL AND ass.accepted_by=$2)`, taskID, actor).Scan(&eligible)
		if err != nil {
			return result, err
		}
		if !eligible {
			return result, domain.ErrForbidden
		}
		var allow bool
		err = r.Q.QueryRow(ctx, `SELECT g.substitutable AND tv.lifecycle='published'
	 AND tv.role_policy->>'allowOverrideReview'='true' FROM cdw_review_gates g
	 JOIN cdw_deliveries d ON d.id=g.delivery_id JOIN cdw_tasks t ON t.id=d.task_id
	 JOIN cdw_workflow_template_versions tv ON tv.id=t.template_version_id WHERE g.id=$1`, gateID).Scan(&allow)
		if err != nil {
			return result, err
		}
		if !allow {
			return result, domain.ErrForbidden
		}
	}
	nextGate, nextTask := "accepted", "accepted_delivery"
	if decision == "return" {
		nextGate, nextTask = "returned", "returned"
	} else if overrideGrantID != "" {
		nextGate = "substituted"
	}
	var actingFor *string
	var grant *string
	if overrideGrantID != "" {
		actingFor = &reviewer
		grant = &overrideGrantID
	}
	if _, err = r.Q.Exec(ctx, `INSERT INTO cdw_review_decisions
 (id,gate_id,actor_id,acting_for_id,override_grant_id,decision,reason)
 VALUES($1,$2,$3,$4,$5,$6,$7)`, decisionID, gateID, actor, actingFor, grant, decision, reason); err != nil {
		return result, err
	}
	if decision == "return" {
		var executor string
		err = r.Q.QueryRow(ctx, `SELECT accepted_by FROM cdw_task_assignments
 WHERE task_id=$1 AND kind='primary' AND ended_at IS NULL`, taskID).Scan(&executor)
		if err != nil || executor == "" {
			return result, domain.ErrConflict
		}
		if _, err = r.Q.Exec(ctx, `INSERT INTO cdw_return_orders
 (id,delivery_id,gate_id,issued_by,assigned_to,reason,round_no)
 VALUES($1,$2,$3,$4,$5,$6,$7)`, orderID, deliveryID, gateID, actor, executor, reason, round); err != nil {
			return result, err
		}
	}
	if _, err = r.Q.Exec(ctx, `UPDATE cdw_review_gates SET state=$2,revision=revision+1 WHERE id=$1`, gateID, nextGate); err != nil {
		return result, err
	}
	if _, err = r.Q.Exec(ctx, `UPDATE cdw_tasks SET state=$2,revision=revision+1 WHERE id=$1`, taskID, nextTask); err != nil {
		return result, err
	}
	result = ports.CDWReviewDecisionResult{GateID: gateID, DeliveryID: deliveryID, TaskID: taskID, State: nextGate, TaskState: nextTask, Revision: rev + 1, Round: round}
	if decision == "return" {
		result.ReturnOrderID = orderID
	}
	if overrideGrantID != "" {
		result.ActingForID = reviewer
		result.OverrideGrantID = overrideGrantID
	}
	return result, nil
}
func (r *Repository) CDWResumeReturned(ctx context.Context, taskID, actor string, expected int64, branchID, revisionID string) (ports.CDWResumeResult, error) {
	var result ports.CDWResumeResult
	var state, fileID string
	var round int
	var rev int64
	err := r.Q.QueryRow(ctx, `SELECT state,file_id,round_no,revision FROM cdw_tasks WHERE id=$1 FOR UPDATE`, taskID).Scan(&state, &fileID, &round, &rev)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, domain.ErrNotFound
	}
	if err != nil {
		return result, err
	}
	if state != "returned" || rev != expected {
		return result, domain.ErrVersionConflict
	}
	var acceptedBy string
	var group *string
	err = r.Q.QueryRow(ctx, `SELECT accepted_by,group_id FROM cdw_task_assignments
 WHERE task_id=$1 AND kind='primary' AND ended_at IS NULL AND accepted_at IS NOT NULL FOR UPDATE`, taskID).Scan(&acceptedBy, &group)
	if err != nil || acceptedBy != actor {
		return result, domain.ErrForbidden
	}
	grp := ""
	if group != nil {
		grp = *group
	}
	if err = r.cdwVerifyBranchActor(ctx, actor, grp); err != nil {
		return result, err
	}
	var priorBranch, baseVersion, baseSHA, blobID, sha string
	var size int64
	err = r.Q.QueryRow(ctx, `SELECT i.branch_id,b.base_version_id,b.base_sha256,i.blob_id,i.sha256,rev.size_bytes
 FROM cdw_deliveries d JOIN cdw_review_gates g ON g.delivery_id=d.id
 JOIN cdw_return_orders o ON o.gate_id=g.id
 JOIN cdw_delivery_items i ON i.delivery_id=d.id AND i.ordinal=1
 JOIN cdw_work_branches b ON b.id=i.branch_id
 JOIN cdw_work_branch_revisions rev ON rev.id=i.branch_revision_id
 WHERE d.task_id=$1 AND d.round_no=$2 AND g.state='returned'
 AND o.assigned_to=$3 AND b.state='frozen' AND i.file_id=$4
 ORDER BY o.created_at DESC LIMIT 1`, taskID, round, actor, fileID).Scan(&priorBranch, &baseVersion, &baseSHA, &blobID, &sha, &size)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, domain.ErrConflict
	}
	if err != nil {
		return result, err
	}
	if _, err = r.Q.Exec(ctx, `INSERT INTO cdw_work_branches
 (id,task_id,file_id,base_version_id,base_sha256,head_revision_id,created_by,state)
 VALUES($1,$2,$3,$4,$5,NULL,$6,'open')`, branchID, taskID, fileID, baseVersion, baseSHA, actor); err != nil {
		return result, err
	}
	if _, err = r.Q.Exec(ctx, `INSERT INTO cdw_work_branch_revisions
 (id,branch_id,ordinal,parent_revision_id,blob_id,sha256,size_bytes,save_epoch)
 VALUES($1,$2,1,NULL,$3,$4,$5,1)`, revisionID, branchID, blobID, sha, size); err != nil {
		return result, err
	}
	if _, err = r.Q.Exec(ctx, `UPDATE cdw_work_branches SET head_revision_id=$2,revision=revision+1 WHERE id=$1`, branchID, revisionID); err != nil {
		return result, err
	}
	if _, err = r.Q.Exec(ctx, `UPDATE cdw_tasks SET state='accepted',round_no=round_no+1,revision=revision+1 WHERE id=$1`, taskID); err != nil {
		return result, err
	}
	result = ports.CDWResumeResult{TaskID: taskID, BranchID: branchID, Revision: rev + 1, Round: round + 1, State: "accepted"}
	_ = priorBranch
	return result, nil
}
