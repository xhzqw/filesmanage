package postgres

import (
	"context"
	"filesmanage/internal/ports"
	"time"
)

func (r *Repository) CDWQMSFormalNoticeLedger(ctx context.Context, actor string, limit int) ([]ports.CDWQMSFormalNotice, error) {
	rows, err := r.Q.Query(ctx, `SELECT n.id,n.approval_instance_id,sub.file_id,n.recipient_id,
 n.event_kind,n.created_at,n.read_at,f.requested_at,COALESCE(f.reason,''),COALESCE(f.requested_by,'')
 FROM cdw_qms_formal_interruption_alerts n
 JOIN cdw_formal_approval_instances a ON a.id=n.approval_instance_id
 JOIN cdw_approval_subjects sub ON sub.id=a.subject_id
 LEFT JOIN cdw_qms_formal_notice_followups f ON f.notice_id=n.id
 WHERE EXISTS (SELECT 1 FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
  WHERE b.user_id=$1 AND b.role='document_control'
  AND (b.file_id=sub.file_id OR b.file_id IS NULL)
  AND b.department_id IS NULL AND b.revoked_at IS NULL
  AND b.valid_from<=clock_timestamp() AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp())
  AND u.disabled_at IS NULL)
 ORDER BY CASE WHEN n.read_at IS NULL THEN 0 ELSE 1 END,n.created_at DESC,n.id DESC LIMIT $2`,
		actor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWQMSFormalNotice{}
	for rows.Next() {
		var n ports.CDWQMSFormalNotice
		var at time.Time
		var ack, reminded *time.Time
		if err = rows.Scan(&n.ID, &n.ApprovalInstanceID, &n.FileID, &n.RecipientID,
			&n.EventKind, &at, &ack, &reminded, &n.FollowupReason, &n.FollowupBy); err != nil {
			return nil, err
		}
		n.CreatedAt = at.UTC().Format(time.RFC3339Nano)
		if ack != nil {
			v := ack.UTC().Format(time.RFC3339Nano)
			n.ReadAt = &v
		}
		if reminded != nil {
			v := reminded.UTC().Format(time.RFC3339Nano)
			n.FollowupAt = &v
		}
		out = append(out, n)
	}
	return out, rows.Err()
}
