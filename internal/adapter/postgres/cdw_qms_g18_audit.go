package postgres

import (
	"context"
	"filesmanage/internal/ports"
	"time"
)

func (r *Repository) CDWQMSAuditCanExport(ctx context.Context, actor, fileID string) (bool, error) {
	var allowed bool
	err := r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_business_role_bindings b
 JOIN users u ON u.id=b.user_id WHERE b.user_id=$1 AND b.role='document_control'
 AND (b.file_id=$2 OR b.file_id IS NULL) AND b.department_id IS NULL
 AND b.revoked_at IS NULL AND b.valid_from<=clock_timestamp()
 AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp()) AND u.disabled_at IS NULL)`, actor, fileID).Scan(&allowed)
	return allowed, err
}
func (r *Repository) CDWQMSAuditFacts(ctx context.Context, approvalIDs []string) (ports.CDWQMSAuditFacts, error) {
	result := ports.CDWQMSAuditFacts{Decisions: []ports.CDWQMSAuditDecision{}, Notices: []ports.CDWQMSAuditNotice{}}
	rows, err := r.Q.Query(ctx, `SELECT step.instance_id,step.id,step.node_key,d.actor_id,
 d.decision,d.reason,d.subject_sha256,d.actor_authority_snapshot,d.decided_at
 FROM cdw_formal_approval_decisions d
 JOIN cdw_formal_approval_steps step ON step.id=d.step_id
 WHERE step.instance_id=ANY($1) ORDER BY d.decided_at,step.instance_id,step.sequence_no,step.node_key`, approvalIDs)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var d ports.CDWQMSAuditDecision
		var at time.Time
		if err = rows.Scan(&d.ApprovalID, &d.StepID, &d.NodeKey, &d.ActorID, &d.Decision,
			&d.Reason, &d.SubjectSHA256, &d.AuthoritySnapshot, &at); err != nil {
			rows.Close()
			return result, err
		}
		d.DecidedAt = at.UTC().Format(time.RFC3339Nano)
		result.Decisions = append(result.Decisions, d)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	rows, err = r.Q.Query(ctx, `SELECT n.approval_instance_id,n.id,n.recipient_id,n.event_kind,
 n.created_at,n.read_at,COALESCE(f.requested_by,''),COALESCE(f.reason,''),f.requested_at
 FROM cdw_qms_formal_interruption_alerts n
 LEFT JOIN cdw_qms_formal_notice_followups f ON f.notice_id=n.id
 WHERE n.approval_instance_id=ANY($1)
 ORDER BY n.created_at,n.approval_instance_id,n.recipient_id`, approvalIDs)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var n ports.CDWQMSAuditNotice
		var at time.Time
		var read, followup *time.Time
		if err = rows.Scan(&n.ApprovalID, &n.NoticeID, &n.RecipientID, &n.EventKind,
			&at, &read, &n.FollowupBy, &n.FollowupReason, &followup); err != nil {
			return result, err
		}
		n.CreatedAt = at.UTC().Format(time.RFC3339Nano)
		if read != nil {
			v := read.UTC().Format(time.RFC3339Nano)
			n.ReadAt = &v
		}
		if followup != nil {
			v := followup.UTC().Format(time.RFC3339Nano)
			n.FollowupAt = &v
		}
		result.Notices = append(result.Notices, n)
	}
	return result, rows.Err()
}
