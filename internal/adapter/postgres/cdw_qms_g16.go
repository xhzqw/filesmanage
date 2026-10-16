package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"time"

	"github.com/jackc/pgx/v5"
)

func (r *Repository) CDWQMSLegacyAnomalies(ctx context.Context, actor string, limit int) ([]ports.CDWQMSLegacyAnomaly, error) {
	rows, err := r.Q.Query(ctx, `SELECT a.approval_instance_id,a.file_id,a.file_name,
 a.template_version_id,a.requested_by,a.completed_decisions,a.sha256
 FROM cdw_qms_formal_legacy_pending_anomalies a WHERE EXISTS(
  SELECT 1 FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
  WHERE b.user_id=$1 AND b.role='document_control'
    AND (b.file_id=a.file_id OR b.file_id IS NULL)
    AND b.department_id IS NULL AND b.revoked_at IS NULL
    AND b.valid_from<=clock_timestamp() AND u.disabled_at IS NULL
    AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp()))
 ORDER BY a.requested_at,a.approval_instance_id LIMIT $2`, actor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWQMSLegacyAnomaly{}
	for rows.Next() {
		var item ports.CDWQMSLegacyAnomaly
		if err = rows.Scan(&item.ApprovalInstanceID, &item.FileID, &item.FileName,
			&item.TemplateVersionID, &item.RequestedBy, &item.CompletedDecisions, &item.SHA256); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
func (r *Repository) CDWQMSHoldLegacy(ctx context.Context, id, approvalID, actor, reason string) (ports.CDWQMSLegacyHold, error) {
	var out ports.CDWQMSLegacyHold
	var fileID, hash, template, requester string
	var count int
	err := r.Q.QueryRow(ctx, `SELECT s.file_id,s.sha256,a.template_version_id,a.requested_by,
 (SELECT COUNT(*) FROM cdw_formal_approval_decisions d JOIN cdw_formal_approval_steps st
  ON st.id=d.step_id WHERE st.instance_id=a.id)
 FROM cdw_formal_approval_instances a JOIN cdw_approval_subjects s ON s.id=a.subject_id
 WHERE a.id=$1`, approvalID).Scan(&fileID, &hash, &template, &requester, &count)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if actor == requester {
		return out, domain.ErrForbidden
	}
	if _, err = r.CDWControlRole(ctx, actor, "document_control", fileID); err != nil {
		return out, err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_qms_formal_legacy_holds
 (id,approval_instance_id,subject_file_id,subject_sha256,template_version_id,held_by,reason,completed_decisions)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, id, approvalID, fileID, hash, template, actor, reason, count)
	if err != nil {
		return out, err
	}
	return ports.CDWQMSLegacyHold{ID: id, ApprovalInstanceID: approvalID, FileID: fileID, State: "conflicted"}, nil
}
func (r *Repository) CDWQMSFormalNotices(ctx context.Context, actor string, limit int) ([]ports.CDWQMSFormalNotice, error) {
	rows, err := r.Q.Query(ctx, `SELECT n.id,n.approval_instance_id,sub.file_id,n.recipient_id,
 n.event_kind,n.created_at,n.read_at,f.requested_at,COALESCE(f.reason,''),COALESCE(f.requested_by,'')
 FROM cdw_qms_formal_interruption_alerts n
 JOIN cdw_formal_approval_instances a ON a.id=n.approval_instance_id
 JOIN cdw_approval_subjects sub ON sub.id=a.subject_id
 LEFT JOIN cdw_qms_formal_notice_followups f ON f.notice_id=n.id
 WHERE n.recipient_id=$1 ORDER BY n.created_at DESC,n.id DESC LIMIT $2`, actor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWQMSFormalNotice{}
	for rows.Next() {
		var item ports.CDWQMSFormalNotice
		var at time.Time
		var read *time.Time
		var followup *time.Time
		if err = rows.Scan(&item.ID, &item.ApprovalInstanceID, &item.FileID, &item.RecipientID, &item.EventKind, &at, &read,
			&followup, &item.FollowupReason, &item.FollowupBy); err != nil {
			return nil, err
		}
		item.CreatedAt = at.UTC().Format(time.RFC3339Nano)
		if read != nil {
			v := read.UTC().Format(time.RFC3339Nano)
			item.ReadAt = &v
		}
		if followup != nil {
			v := followup.UTC().Format(time.RFC3339Nano)
			item.FollowupAt = &v
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
func (r *Repository) CDWQMSReadFormalNotice(ctx context.Context, id, actor string) (bool, error) {
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_qms_formal_interruption_alerts
 SET read_at=clock_timestamp() WHERE id=$1 AND recipient_id=$2 AND read_at IS NULL`, id, actor)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// The formal starter already holds the file lock and has resolved the
// accepted delivery's file ID. Checking file ID, never delivery ID, prevents
// a new delivery from bypassing an older interrupted approval obligation.
func (r *Repository) CDWQMSRequiresRestart(ctx context.Context, fileID string) (bool, error) {
	var required bool
	err := r.Q.QueryRow(ctx, `SELECT EXISTS(
 SELECT 1 FROM cdw_approval_subjects sub
 JOIN cdw_formal_approval_instances a ON a.subject_id=sub.id
 WHERE sub.file_id=$1 AND (
  EXISTS(SELECT 1 FROM cdw_qms_formal_policy_interruptions h WHERE h.approval_instance_id=a.id)
  OR EXISTS(SELECT 1 FROM cdw_qms_formal_legacy_holds h WHERE h.approval_instance_id=a.id))
  AND NOT EXISTS(SELECT 1 FROM cdw_qms_formal_restarts link WHERE link.previous_approval_id=a.id)
 )`, fileID).Scan(&required)
	return required, err
}
func (r *Repository) CDWQMSRecordRestart(ctx context.Context, id, previousID, newID, actor string) error {
	tag, err := r.Q.Exec(ctx, `INSERT INTO cdw_qms_formal_restarts
 (id,previous_approval_id,new_approval_id,file_id,previous_sha256,new_sha256,submitted_by)
 SELECT $1,old.id,new.id,old_subject.file_id,old_subject.sha256,new_subject.sha256,$4
 FROM cdw_formal_approval_instances old
 JOIN cdw_approval_subjects old_subject ON old_subject.id=old.subject_id
 CROSS JOIN cdw_formal_approval_instances new
 JOIN cdw_approval_subjects new_subject ON new_subject.id=new.subject_id
 WHERE old.id=$2 AND new.id=$3 AND old_subject.file_id=new_subject.file_id`,
		id, previousID, newID, actor)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return domain.ErrConflict
	}
	return nil
}
