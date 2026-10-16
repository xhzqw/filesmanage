package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"time"

	"github.com/jackc/pgx/v5"
)

// A read-only ordered chain, with every node anchored to its immutable
// subject hash and actual decision/recipient evidence (never inferred ACKs).
func (r *Repository) CDWQMSFormalLineage(ctx context.Context, focusID string) (ports.CDWQMSFormalLineage, error) {
	out := ports.CDWQMSFormalLineage{FocusApprovalID: focusID, Nodes: []ports.CDWQMSLineageNode{}}
	rows, err := r.Q.Query(ctx, `WITH RECURSIVE
 parents(id,depth) AS (
  SELECT $1::text,0
  UNION ALL
  SELECT link.previous_approval_id,parents.depth+1 FROM parents
  JOIN cdw_qms_formal_restarts link ON link.new_approval_id=parents.id
  WHERE parents.depth<30
 ),
 root(id) AS (SELECT id FROM parents ORDER BY depth DESC LIMIT 1),
 chain(id,depth) AS (
  SELECT id,0 FROM root
  UNION ALL
  SELECT link.new_approval_id,chain.depth+1 FROM chain
  JOIN cdw_qms_formal_restarts link ON link.previous_approval_id=chain.id
  WHERE chain.depth<30
 )
 SELECT a.id,COALESCE(link.previous_approval_id,''),sub.file_id,
  COALESCE(f.name,''),sub.sha256,a.template_version_id,
  COALESCE(t.authority_basis_release_id,''),a.state,a.requested_by,
  a.requested_at,a.completed_at,
  (SELECT count(*) FROM cdw_formal_approval_steps s WHERE s.instance_id=a.id),
  (SELECT count(*) FROM cdw_formal_approval_decisions d
   JOIN cdw_formal_approval_steps s ON s.id=d.step_id
   WHERE s.instance_id=a.id AND d.decision='approve'),
  (SELECT count(*) FROM cdw_formal_approval_decisions d
   JOIN cdw_formal_approval_steps s ON s.id=d.step_id
   WHERE s.instance_id=a.id AND d.decision='reject'),
  (SELECT count(*) FROM cdw_formal_approval_steps s
   WHERE s.instance_id=a.id AND s.state IN('ready','waiting')),
  (SELECT count(*) FROM cdw_qms_formal_interruption_alerts n WHERE n.approval_instance_id=a.id),
  (SELECT count(*) FROM cdw_qms_formal_interruption_alerts n
   WHERE n.approval_instance_id=a.id AND n.read_at IS NOT NULL),
  CASE WHEN h.id IS NOT NULL THEN h.cause
   WHEN legacy.id IS NOT NULL THEN 'legacy_quarantined' ELSE '' END,
  COALESCE(candidate.id,''),chain.depth
 FROM chain
 JOIN cdw_formal_approval_instances a ON a.id=chain.id
 JOIN cdw_approval_subjects sub ON sub.id=a.subject_id
 JOIN cdw_workflow_template_versions t ON t.id=a.template_version_id
 LEFT JOIN files f ON f.id=sub.file_id
 LEFT JOIN cdw_qms_formal_restarts link ON link.new_approval_id=a.id
 LEFT JOIN cdw_qms_formal_policy_interruptions h ON h.approval_instance_id=a.id
 LEFT JOIN cdw_qms_formal_legacy_holds legacy ON legacy.approval_instance_id=a.id
 LEFT JOIN cdw_approved_candidates candidate ON candidate.approval_instance_id=a.id
 ORDER BY chain.depth`, focusID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var n ports.CDWQMSLineageNode
		var requested time.Time
		var finished *time.Time
		var depth int
		if err = rows.Scan(&n.ApprovalID, &n.PreviousApprovalID, &n.FileID, &n.FileName,
			&n.SHA256, &n.TemplateVersionID, &n.PolicyReleaseID, &n.State, &n.RequestedBy,
			&requested, &finished, &n.StepCount, &n.ApprovedCount, &n.RejectedCount,
			&n.PendingCount, &n.NoticeTotal, &n.NoticeRead, &n.InterruptionReason,
			&n.CandidateID, &depth); err != nil {
			return out, err
		}
		n.RequestedAt = requested.UTC().Format(time.RFC3339Nano)
		if finished != nil {
			v := finished.UTC().Format(time.RFC3339Nano)
			n.CompletedAt = &v
		}
		if depth == 30 {
			out.Truncated = true
		}
		out.Nodes = append(out.Nodes, n)
	}
	if err = rows.Err(); err != nil {
		return out, err
	}
	if len(out.Nodes) == 0 {
		return out, domain.ErrNotFound
	}
	// Distinguish a complete 31-node chain from a larger one without allowing
	// unbounded recursion in normal authenticated list/detail requests.
	if out.Truncated {
		var next bool
		err = r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_qms_formal_restarts
 WHERE previous_approval_id=$1)`, out.Nodes[len(out.Nodes)-1].ApprovalID).Scan(&next)
		if errors.Is(err, pgx.ErrNoRows) {
			err = nil
		}
		if err != nil {
			return out, err
		}
		out.Truncated = next
	}
	return out, nil
}
