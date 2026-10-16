package postgres

import (
	"context"
	"filesmanage/internal/ports"
	"time"
)

// The affected approval is an immutable closed historical instance. There is
// intentionally no resume API; reapproval creates a new frozen subject.
func (r *Repository) CDWQMSFormalInterruptions(ctx context.Context, actor string, limit int) ([]ports.CDWQMSFormalInterruption, error) {
	rows, err := r.Q.Query(ctx, `SELECT h.id,h.approval_instance_id,h.authority_id,
 h.subject_file_id,f.name,policy.file_id,h.subject_sha256,h.template_version_id,
 h.old_policy_release_id,COALESCE(h.replacement_policy_release_id,''),
 h.cause,h.completed_decisions,h.interrupted_nodes,h.interrupted_at
 FROM cdw_qms_formal_policy_interruptions h
 JOIN cdw_formal_approval_instances inst ON inst.id=h.approval_instance_id
 JOIN cdw_controlled_releases policy ON policy.id=h.old_policy_release_id
 JOIN files f ON f.id=h.subject_file_id AND f.deleted_at IS NULL
 WHERE (inst.requested_by=$1
   OR EXISTS(SELECT 1 FROM cdw_formal_approval_steps step
    WHERE step.instance_id=inst.id AND step.approver_user_id=$1)
   OR EXISTS(SELECT 1 FROM cdw_business_role_bindings bind
     JOIN users usr ON usr.id=bind.user_id
     WHERE bind.user_id=$1 AND bind.role='document_control'
      AND (bind.file_id=h.subject_file_id OR bind.file_id IS NULL)
      AND bind.department_id IS NULL AND bind.revoked_at IS NULL
      AND bind.valid_from<=clock_timestamp() AND usr.disabled_at IS NULL
      AND (bind.expires_at IS NULL OR bind.expires_at>clock_timestamp())))
 ORDER BY h.interrupted_at DESC,h.id DESC LIMIT $2`, actor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWQMSFormalInterruption{}
	for rows.Next() {
		var item ports.CDWQMSFormalInterruption
		var at time.Time
		err = rows.Scan(&item.ID, &item.ApprovalInstanceID, &item.AuthorityID,
			&item.SubjectFileID, &item.SubjectName, &item.PolicyFileID,
			&item.SubjectSHA256, &item.TemplateVersionID, &item.OldPolicyReleaseID,
			&item.ReplacementPolicyReleaseID, &item.Cause, &item.CompletedDecisions,
			&item.InterruptedNodes, &at)
		if err != nil {
			return nil, err
		}
		item.InterruptedAt = at.UTC().Format(time.RFC3339Nano)
		out = append(out, item)
	}
	return out, rows.Err()
}
