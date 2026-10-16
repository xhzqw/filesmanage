package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"time"

	"github.com/jackc/pgx/v5"
)

func (r *Repository) CDWQMSFormalNoticeFile(ctx context.Context, id string) (string, error) {
	var file string
	err := r.Q.QueryRow(ctx, `SELECT sub.file_id FROM cdw_qms_formal_interruption_alerts n
 JOIN cdw_formal_approval_instances a ON a.id=n.approval_instance_id
 JOIN cdw_approval_subjects sub ON sub.id=a.subject_id WHERE n.id=$1`, id).Scan(&file)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	return file, err
}
func (r *Repository) CDWQMSFormalFollowup(ctx context.Context, id, noticeID, actor, reason string) (ports.CDWQMSFormalFollowup, error) {
	var out ports.CDWQMSFormalFollowup
	var requestedAt time.Time
	err := r.Q.QueryRow(ctx, `INSERT INTO cdw_qms_formal_notice_followups
 (id,notice_id,approval_instance_id,recipient_id,requested_by,reason)
 SELECT $1,n.id,n.approval_instance_id,n.recipient_id,$3,$4
 FROM cdw_qms_formal_interruption_alerts n WHERE n.id=$2
 RETURNING id,notice_id,approval_instance_id,recipient_id,requested_by,reason,requested_at`,
		id, noticeID, actor, reason).Scan(&out.ID, &out.NoticeID, &out.ApprovalInstanceID,
		&out.RecipientID, &out.RequestedBy, &out.Reason, &requestedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	out.RequestedAt = requestedAt.UTC().Format(time.RFC3339Nano)
	return out, nil
}
