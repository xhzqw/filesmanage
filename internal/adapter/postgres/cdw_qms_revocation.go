package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
	"time"
)

func (r *Repository) CDWQMSRevokeAppointment(ctx context.Context, id, actor, reason string) (ports.CDWQMSAppointment, error) {
	var fileID, nominee, proposer, status string
	err := r.Q.QueryRow(ctx, `SELECT file_id,user_id,proposed_by,status
 FROM cdw_qms_appointments WHERE id=$1 FOR UPDATE`, id).Scan(&fileID, &nominee, &proposer, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.CDWQMSAppointment{}, domain.ErrNotFound
	}
	if err != nil {
		return ports.CDWQMSAppointment{}, err
	}
	if status != "verified" {
		return ports.CDWQMSAppointment{}, domain.ErrConflict
	}
	if actor == nominee || actor == proposer {
		return ports.CDWQMSAppointment{}, domain.ErrForbidden
	}
	if _, err = r.CDWControlRole(ctx, actor, "document_control", fileID); err != nil {
		return ports.CDWQMSAppointment{}, err
	}
	_, err = r.Q.Exec(ctx, `UPDATE cdw_qms_appointments SET status='revoked',
 revoked_by=$2,revoked_at=clock_timestamp(),revocation_reason=$3
 WHERE id=$1 AND status='verified'`, id, actor, reason)
	if err != nil {
		return ports.CDWQMSAppointment{}, err
	}
	// Persist recipient-specific notices in the SAME transaction as the
	// revocation and domain event. Notifications are not inferred from outbox.
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_qms_appointment_alerts(id,appointment_id,recipient_id,event_kind)
 SELECT 'cdw_qms_alert_'||md5($1||':'||recipients.user_id),$1,recipients.user_id,'revoked'
 FROM (
  SELECT a.user_id FROM cdw_qms_appointments a WHERE a.id=$1
  UNION SELECT a.proposed_by FROM cdw_qms_appointments a WHERE a.id=$1
  UNION SELECT a.verified_by FROM cdw_qms_appointments a WHERE a.id=$1 AND a.verified_by IS NOT NULL
  UNION SELECT st.approver_user_id FROM cdw_qms_appointments ap
   JOIN cdw_approval_subjects sub ON sub.file_id=ap.file_id
   JOIN cdw_formal_approval_instances inst ON inst.subject_id=sub.id AND inst.state='pending'
   JOIN cdw_workflow_template_versions tv ON tv.id=inst.template_version_id
   JOIN cdw_formal_approval_steps st ON st.instance_id=inst.id
    AND st.state IN('ready','waiting') AND st.node_key=ap.node_key
   WHERE ap.id=$1 AND tv.authority_basis_release_id=ap.policy_release_id
 ) recipients
 JOIN users u ON u.id=recipients.user_id AND u.disabled_at IS NULL
 ON CONFLICT (appointment_id,recipient_id,event_kind) DO NOTHING`, id)
	if err != nil {
		return ports.CDWQMSAppointment{}, err
	}
	return cdwScanAppointment(r.Q.QueryRow(ctx, `SELECT `+cdwQMSAppointmentColumns+
		` FROM cdw_qms_appointments WHERE id=$1`, id))
}

func (r *Repository) CDWQMSAppointmentAlerts(ctx context.Context, actor string, limit int) ([]ports.CDWQMSAppointmentAlert, error) {
	rows, err := r.Q.Query(ctx, `SELECT n.id,n.appointment_id,a.file_id,a.node_key,n.created_at,n.read_at
 FROM cdw_qms_appointment_alerts n JOIN cdw_qms_appointments a ON a.id=n.appointment_id
 WHERE n.recipient_id=$1 ORDER BY n.created_at DESC,n.id DESC LIMIT $2`, actor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWQMSAppointmentAlert{}
	for rows.Next() {
		var alert ports.CDWQMSAppointmentAlert
		var created time.Time
		var seen *time.Time
		if err = rows.Scan(&alert.ID, &alert.AppointmentID, &alert.FileID, &alert.NodeKey, &created, &seen); err != nil {
			return nil, err
		}
		alert.CreatedAt = created.UTC().Format(time.RFC3339Nano)
		if seen != nil {
			v := seen.UTC().Format(time.RFC3339Nano)
			alert.ReadAt = &v
		}
		out = append(out, alert)
	}
	return out, rows.Err()
}

func (r *Repository) CDWQMSReadAppointmentAlert(ctx context.Context, id, actor string) (bool, error) {
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_qms_appointment_alerts
 SET read_at=COALESCE(read_at,clock_timestamp())
 WHERE id=$1 AND recipient_id=$2 AND read_at IS NULL`, id, actor)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func (r *Repository) CDWQMSAppointmentEvidenceSource(ctx context.Context, id string) (ports.CDWQMSAppointmentEvidenceSource, error) {
	var v ports.CDWQMSAppointmentEvidenceSource
	err := r.Q.QueryRow(ctx, `SELECT bl.storage_key,rel.display_name_snapshot,bl.size_bytes,
 a.sha256,rel.id FROM cdw_qms_appointments ap
 JOIN cdw_controlled_releases rel ON rel.id=ap.evidence_release_id
 JOIN cdw_effective_pointers pointer ON pointer.file_id=rel.file_id
   AND pointer.release_id=rel.id AND pointer.state='active'
 JOIN cdw_release_artifacts a ON a.release_id=rel.id
   AND a.purpose='distribution' AND a.format='docx'
 JOIN cdw_distribution_batch_items item ON item.release_id=rel.id
   AND item.artifact_id=a.id AND item.artifact_sha256=a.sha256
 JOIN cdw_distribution_batches batch ON batch.id=item.batch_id AND batch.state='dispatched'
 JOIN blobs bl ON bl.id=a.blob_id AND bl.state='ready' AND bl.sha256=a.sha256
   AND bl.size_bytes=a.size_bytes
 WHERE ap.id=$1 AND rel.state='effective'
 ORDER BY a.created_at DESC LIMIT 1`, id).
		Scan(&v.StorageKey, &v.Name, &v.SizeBytes, &v.SHA256, &v.ReleaseID)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, domain.ErrPolicyAuthorityPending
	}
	return v, err
}
