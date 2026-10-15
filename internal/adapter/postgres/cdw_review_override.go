package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"time"

	"github.com/jackc/pgx/v5"
)

// Authorizing an override never means assigning formal document approval.
// Candidates are exclusively current accepted task-tree ancestors; never
// company-wide directory results. The service filters by file ACL again.
func (r *Repository) CDWReviewCandidates(ctx context.Context, gateID string) ([]ports.CDWReviewCandidate, error) {
	rows, err := r.Q.Query(ctx, `WITH RECURSIVE ancestors AS (
 SELECT t.parent_id AS parent_id,0 depth FROM cdw_review_gates g
 JOIN cdw_deliveries d ON d.id=g.delivery_id JOIN cdw_tasks t ON t.id=d.task_id WHERE g.id=$1
 UNION ALL SELECT t.parent_id,a.depth+1 FROM cdw_tasks t JOIN ancestors a ON t.id=a.parent_id WHERE a.parent_id IS NOT NULL
 ) SELECT DISTINCT u.id,u.display_name FROM ancestors a
 JOIN cdw_task_assignments ass ON ass.task_id=a.parent_id
 JOIN users u ON u.id=ass.accepted_by
 WHERE a.depth>=1 AND ass.kind='primary' AND ass.ended_at IS NULL
 AND ass.accepted_at IS NOT NULL AND u.disabled_at IS NULL ORDER BY u.display_name,u.id`, gateID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWReviewCandidate{}
	for rows.Next() {
		var row ports.CDWReviewCandidate
		if err = rows.Scan(&row.ID, &row.DisplayName); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
func (r *Repository) CDWReviewAccess(ctx context.Context, gateID, actor string) (string, error) {
	var reviewer string
	var substitutable bool
	var taskID string
	var active bool
	err := r.Q.QueryRow(ctx, `SELECT g.responsible_user_id,g.substitutable,d.task_id,
 (g.state='awaiting' AND t.state='submitted') FROM cdw_review_gates g
 JOIN cdw_deliveries d ON d.id=g.delivery_id JOIN cdw_tasks t ON t.id=d.task_id WHERE g.id=$1`, gateID).Scan(&reviewer, &substitutable, &taskID, &active)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if actor == reviewer {
		return "", nil
	}
	if !active || !substitutable {
		return "", domain.ErrForbidden
	}
	var id string
	err = r.Q.QueryRow(ctx, `SELECT gr.id FROM cdw_override_grants gr
 JOIN cdw_tasks t ON t.id=gr.task_id
 JOIN cdw_workflow_template_versions tv ON tv.id=t.template_version_id
 WHERE gr.gate_id=$1 AND gr.task_id=$2 AND gr.actor_id=$3
 AND gr.granted_by=$4 AND 'substitute_review_gate'=ANY(gr.actions)
 AND gr.revoked_at IS NULL AND gr.valid_from<=now() AND gr.expires_at>now()
 AND tv.lifecycle='published' AND tv.role_policy->>'allowOverrideReview'='true'
 ORDER BY gr.valid_from DESC LIMIT 1`, gateID, taskID, actor, reviewer).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrForbidden
	}
	return id, err
}
func (r *Repository) CDWGrantReview(ctx context.Context, gateID, reviewer, target string, expected int64, reason, grantID string) (ports.CDWOverrideGrant, error) {
	var out ports.CDWOverrideGrant
	var taskID, state, original string
	var substitutable, allowed bool
	var revision int64
	err := r.Q.QueryRow(ctx, `SELECT d.task_id FROM cdw_review_gates g JOIN cdw_deliveries d ON d.id=g.delivery_id WHERE g.id=$1`, gateID).Scan(&taskID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	// stable lock ordering matches review decision: task first, gate second
	var taskState string
	if err = r.Q.QueryRow(ctx, `SELECT state FROM cdw_tasks WHERE id=$1 FOR UPDATE`, taskID).Scan(&taskState); err != nil {
		return out, err
	}
	err = r.Q.QueryRow(ctx, `SELECT g.state,g.responsible_user_id,g.substitutable,g.revision,
 (tv.lifecycle='published' AND tv.role_policy->>'allowOverrideReview'='true')
 FROM cdw_review_gates g JOIN cdw_deliveries d ON d.id=g.delivery_id
 JOIN cdw_tasks t ON t.id=d.task_id JOIN cdw_workflow_template_versions tv ON tv.id=t.template_version_id
 WHERE g.id=$1 FOR UPDATE OF g`, gateID).Scan(&state, &original, &substitutable, &revision, &allowed)
	if err != nil {
		return out, err
	}
	if taskState != "submitted" || state != "awaiting" || revision != expected {
		return out, domain.ErrVersionConflict
	}
	if reviewer != original || !substitutable || !allowed || target == reviewer {
		return out, domain.ErrForbidden
	}
	// Grant target must be an ACTIVE ancestor's ACCEPTED assignee, strictly
	// ABOVE the responsible direct parent, not arbitrary company admin.
	var ancestor bool
	err = r.Q.QueryRow(ctx, `WITH RECURSIVE ancestors AS (
 SELECT t.parent_id AS parent_id,0 AS depth FROM cdw_tasks t WHERE t.id=$1
 UNION ALL SELECT parent.parent_id,a.depth+1 FROM ancestors a
 JOIN cdw_tasks parent ON parent.id=a.parent_id WHERE a.parent_id IS NOT NULL
 ) SELECT EXISTS(
 SELECT 1 FROM ancestors a JOIN cdw_task_assignments ass ON ass.task_id=a.parent_id
 WHERE a.depth>=1 AND ass.kind='primary' AND ass.ended_at IS NULL
 AND ass.accepted_by=$2 AND ass.accepted_at IS NOT NULL)`, taskID, target).Scan(&ancestor)
	if err != nil {
		return out, err
	}
	if !ancestor {
		return out, domain.ErrForbidden
	}
	if err = r.cdwVerifyDirectReviewer(ctx, taskID, reviewer); err != nil {
		return out, err
	}
	if _, err = r.CDWActiveRecipients(ctx, ports.CDWAssignmentTarget{Kind: "user", ID: target}); err != nil {
		return out, err
	}
	var existing bool
	if err = r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_override_grants WHERE gate_id=$1 AND actor_id=$2 AND revoked_at IS NULL)`, gateID, target).Scan(&existing); err != nil {
		return out, err
	}
	if existing {
		return out, domain.ErrConflict
	}
	var expiry time.Time
	err = r.Q.QueryRow(ctx, `INSERT INTO cdw_override_grants
 (id,granted_by,actor_id,task_id,gate_id,actions,reason,expires_at)
 VALUES($1,$2,$3,$4,$5,ARRAY['substitute_review_gate']::text[],$6,now()+interval '24 hours')
 RETURNING expires_at`, grantID, reviewer, target, taskID, gateID, reason).Scan(&expiry)
	if err != nil {
		return out, err
	}
	return ports.CDWOverrideGrant{ID: grantID, GateID: gateID, TaskID: taskID, GrantedBy: reviewer, ActorID: target, ExpiresAt: expiry.UTC().Format(time.RFC3339Nano)}, nil
}
func (r *Repository) CDWRevokeReviewGrant(ctx context.Context, gateID, grantID, reviewer string) (ports.CDWOverrideGrant, error) {
	var out ports.CDWOverrideGrant
	var id, task, granter, actor string
	var expires time.Time
	var revoked *time.Time
	err := r.Q.QueryRow(ctx, `SELECT id,task_id,granted_by,actor_id,expires_at,revoked_at FROM cdw_override_grants
 WHERE id=$1 AND gate_id=$2 FOR UPDATE`, grantID, gateID).Scan(&id, &task, &granter, &actor, &expires, &revoked)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if granter != reviewer {
		return out, domain.ErrForbidden
	}
	if revoked == nil {
		if _, err = r.Q.Exec(ctx, `UPDATE cdw_override_grants SET revoked_at=now() WHERE id=$1`, id); err != nil {
			return out, err
		}
	}
	return ports.CDWOverrideGrant{ID: id, GateID: gateID, TaskID: task, GrantedBy: granter, ActorID: actor, ExpiresAt: expires.UTC().Format(time.RFC3339Nano), Revoked: true}, nil
}
func (r *Repository) CDWReviewGrants(ctx context.Context, gateID string) ([]ports.CDWOverrideGrant, error) {
	rows, err := r.Q.Query(ctx, `SELECT id,task_id,granted_by,actor_id,expires_at,revoked_at IS NOT NULL
 FROM cdw_override_grants WHERE gate_id=$1 ORDER BY valid_from DESC,id DESC`, gateID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []ports.CDWOverrideGrant{}
	for rows.Next() {
		var gr ports.CDWOverrideGrant
		var expiry time.Time
		if err = rows.Scan(&gr.ID, &gr.TaskID, &gr.GrantedBy, &gr.ActorID, &expiry, &gr.Revoked); err != nil {
			return nil, err
		}
		gr.GateID = gateID
		gr.ExpiresAt = expiry.UTC().Format(time.RFC3339Nano)
		result = append(result, gr)
	}
	return result, rows.Err()
}

// The direct reviewer is revalidated for every decision/grant, including
// revocation/expiry of the parent workgroup appointment.
func (r *Repository) cdwVerifyDirectReviewer(ctx context.Context, taskID, reviewer string) error {
	var current string
	err := r.Q.QueryRow(ctx, `SELECT CASE WHEN t.parent_id IS NULL THEN t.created_by
 ELSE (SELECT a.accepted_by FROM cdw_task_assignments a
 WHERE a.task_id=t.parent_id AND a.kind='primary' AND a.ended_at IS NULL LIMIT 1) END
 FROM cdw_tasks t WHERE t.id=$1`, taskID).Scan(&current)
	if err != nil || current != reviewer {
		return domain.ErrForbidden
	}
	var parentGroup *string
	err = r.Q.QueryRow(ctx, `SELECT a.group_id FROM cdw_tasks t
 JOIN cdw_task_assignments a ON a.task_id=t.parent_id WHERE t.id=$1
 AND a.kind='primary' AND a.ended_at IS NULL`, taskID).Scan(&parentGroup)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if parentGroup != nil {
		allowed, e := r.CDWActiveRecipients(ctx, ports.CDWAssignmentTarget{Kind: "workgroup", ID: *parentGroup})
		if e != nil {
			return e
		}
		valid := false
		for _, id := range allowed {
			if id == reviewer {
				valid = true
				break
			}
		}
		if !valid {
			return domain.ErrForbidden
		}
	}
	_, err = r.CDWActiveRecipients(ctx, ports.CDWAssignmentTarget{Kind: "user", ID: reviewer})
	return err
}
