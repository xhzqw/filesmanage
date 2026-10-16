package postgres

import (
	"context"
	"filesmanage/internal/ports"
)

func (r *Repository) CDWQMSLegacyHoldHistory(ctx context.Context, actor string, limit int) ([]ports.CDWQMSLegacyHold, error) {
	rows, err := r.Q.Query(ctx, `SELECT h.id,h.approval_instance_id,h.subject_file_id
 FROM cdw_qms_formal_legacy_holds h
 JOIN cdw_formal_approval_instances a ON a.id=h.approval_instance_id
 WHERE a.requested_by=$1 OR EXISTS(
  SELECT 1 FROM cdw_formal_approval_steps st WHERE st.instance_id=a.id AND st.approver_user_id=$1)
 OR EXISTS(SELECT 1 FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
  WHERE b.user_id=$1 AND b.role='document_control'
  AND (b.file_id=h.subject_file_id OR b.file_id IS NULL)
  AND b.department_id IS NULL AND b.revoked_at IS NULL AND u.disabled_at IS NULL
  AND b.valid_from<=clock_timestamp() AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp()))
 ORDER BY h.held_at DESC,h.id DESC LIMIT $2`, actor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWQMSLegacyHold{}
	for rows.Next() {
		var item ports.CDWQMSLegacyHold
		if err = rows.Scan(&item.ID, &item.ApprovalInstanceID, &item.FileID); err != nil {
			return nil, err
		}
		item.State = "conflicted"
		out = append(out, item)
	}
	return out, rows.Err()
}
