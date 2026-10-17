package postgres

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"time"
)

// Read both directions inside one bounded query. If either end extends beyond
// the cap, the caller must refuse to advertise a complete evidence packet.
func (r *Repository) CDWQMSAuditChainIDs(ctx context.Context, focus string, limit int) ([]string, bool, error) {
	if limit < 2 || limit > 512 {
		return nil, false, domain.ErrInvalidInput
	}
	rows, err := r.Q.Query(ctx, `WITH RECURSIVE
 parents(id,depth,path) AS (
  SELECT $1::text,0,ARRAY[$1::text]
  UNION ALL
  SELECT l.previous_approval_id,p.depth+1,p.path||l.previous_approval_id
  FROM parents p JOIN cdw_qms_formal_restarts l ON l.new_approval_id=p.id
  WHERE p.depth<$2 AND NOT l.previous_approval_id=ANY(p.path)
 ),
 root AS(SELECT id,depth FROM parents ORDER BY depth DESC LIMIT 1),
 chain(id,depth,path) AS (
  SELECT id,0,ARRAY[id] FROM root
  UNION ALL
  SELECT l.new_approval_id,c.depth+1,c.path||l.new_approval_id
  FROM chain c JOIN cdw_qms_formal_restarts l ON l.previous_approval_id=c.id
  WHERE c.depth<$2 AND NOT l.new_approval_id=ANY(c.path)
 )
 SELECT c.id,EXISTS(SELECT 1 FROM cdw_qms_formal_restarts l WHERE l.new_approval_id=(SELECT id FROM root)),
 EXISTS(SELECT 1 FROM cdw_qms_formal_restarts l WHERE l.previous_approval_id=c.id)
 FROM chain c ORDER BY c.depth`, focus, limit-1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	ids := []string{}
	var missingParent, hasNext bool
	for rows.Next() {
		var id string
		if err = rows.Scan(&id, &missingParent, &hasNext); err != nil {
			return nil, false, err
		}
		ids = append(ids, id)
	}
	if err = rows.Err(); err != nil {
		return nil, false, err
	}
	if len(ids) == 0 {
		return nil, false, domain.ErrNotFound
	}
	// Last scanned row decides descendant continuation. Root test detects
	// ancestor cap. No successful partial export on either truncation.
	return ids, missingParent || hasNext, nil
}

func (r *Repository) CDWQMSAuditNodes(ctx context.Context, ids []string) ([]ports.CDWQMSLineageNode, error) {
	rows, err := r.Q.Query(ctx, `SELECT a.id,COALESCE(link.previous_approval_id,''),
 sub.file_id,COALESCE(f.name,''),sub.sha256,a.template_version_id,
 COALESCE(t.authority_basis_release_id,''),a.state,a.requested_by,
 a.requested_at,a.completed_at,
 (SELECT count(*) FROM cdw_formal_approval_steps s WHERE s.instance_id=a.id),
 (SELECT count(*) FROM cdw_formal_approval_decisions d JOIN cdw_formal_approval_steps s ON s.id=d.step_id
 WHERE s.instance_id=a.id AND d.decision='approve'),
 (SELECT count(*) FROM cdw_formal_approval_decisions d JOIN cdw_formal_approval_steps s ON s.id=d.step_id
 WHERE s.instance_id=a.id AND d.decision='reject'),
 (SELECT count(*) FROM cdw_formal_approval_steps s WHERE s.instance_id=a.id AND s.state IN('ready','waiting')),
 (SELECT count(*) FROM cdw_qms_formal_interruption_alerts n WHERE n.approval_instance_id=a.id),
 (SELECT count(*) FROM cdw_qms_formal_interruption_alerts n WHERE n.approval_instance_id=a.id AND n.read_at IS NOT NULL),
 CASE WHEN h.id IS NOT NULL THEN h.cause WHEN legacy.id IS NOT NULL THEN 'legacy_quarantined' ELSE '' END,
 COALESCE(candidate.id,'')
 FROM cdw_formal_approval_instances a
 JOIN cdw_approval_subjects sub ON sub.id=a.subject_id
 JOIN cdw_workflow_template_versions t ON t.id=a.template_version_id
 LEFT JOIN files f ON f.id=sub.file_id
 LEFT JOIN cdw_qms_formal_restarts link ON link.new_approval_id=a.id
 LEFT JOIN cdw_qms_formal_policy_interruptions h ON h.approval_instance_id=a.id
 LEFT JOIN cdw_qms_formal_legacy_holds legacy ON legacy.approval_instance_id=a.id
 LEFT JOIN cdw_approved_candidates candidate ON candidate.approval_instance_id=a.id
 WHERE a.id=ANY($1) ORDER BY array_position($1::text[],a.id)`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWQMSLineageNode{}
	for rows.Next() {
		var n ports.CDWQMSLineageNode
		var created time.Time
		var finished *time.Time
		if err = rows.Scan(&n.ApprovalID, &n.PreviousApprovalID, &n.FileID, &n.FileName, &n.SHA256,
			&n.TemplateVersionID, &n.PolicyReleaseID, &n.State, &n.RequestedBy,
			&created, &finished, &n.StepCount, &n.ApprovedCount, &n.RejectedCount, &n.PendingCount,
			&n.NoticeTotal, &n.NoticeRead, &n.InterruptionReason, &n.CandidateID); err != nil {
			return nil, err
		}
		n.RequestedAt = created.UTC().Format(time.RFC3339Nano)
		if finished != nil {
			v := finished.UTC().Format(time.RFC3339Nano)
			n.CompletedAt = &v
		}
		out = append(out, n)
	}
	return out, rows.Err()
}
