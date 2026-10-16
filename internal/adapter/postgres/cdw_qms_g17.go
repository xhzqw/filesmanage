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
// Historical participants retain read-only access after signing authority
// revocation, but never receive new signing permissions. File ACL stays live.
func (r *Repository) CDWQMSFormalLineageCanRead(ctx context.Context, id, actor string) (bool, error) {
	var allowed bool
	err := r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1
 FROM cdw_formal_approval_instances a
 JOIN cdw_approval_subjects sub ON sub.id=a.subject_id
 WHERE a.id=$1 AND (a.requested_by=$2
  OR EXISTS(SELECT 1 FROM cdw_formal_approval_steps step
    WHERE step.instance_id=a.id AND step.approver_user_id=$2)
  OR EXISTS(SELECT 1 FROM cdw_business_role_bindings b
   JOIN users u ON u.id=b.user_id
   WHERE b.user_id=$2 AND b.role='document_control'
    AND (b.file_id=sub.file_id OR b.file_id IS NULL)
    AND b.department_id IS NULL AND b.revoked_at IS NULL
    AND b.valid_from<=clock_timestamp()
    AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp())
    AND u.disabled_at IS NULL)))`, id, actor).Scan(&allowed)
	return allowed, err
}
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
	// The parent walk is also depth limited. A nonempty predecessor on the
	// first returned node means it is not the true root. Never mark this
	// suffix as a complete auditable history.
	parentTruncated := out.Nodes[0].PreviousApprovalID != ""
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
	out.Truncated = out.Truncated || parentTruncated
	return out, nil
}
