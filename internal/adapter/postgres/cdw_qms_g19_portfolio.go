package postgres

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"time"
)

// Scope first by an active, file-specific controller binding, then aggregate
// per file. The application applies the full live file ACL before displaying.
func (r *Repository) CDWQMSPortfolio(ctx context.Context, actor string, limit int) (ports.CDWQMSPortfolio, error) {
	out := ports.CDWQMSPortfolio{Items: []ports.CDWQMSPortfolioItem{}, Limit: limit}
	if limit < 1 || limit > 100 {
		return out, domain.ErrInvalidInput
	}
	rows, err := r.Q.Query(ctx, `WITH scoped AS (
 SELECT sub.file_id,max(a.requested_at) AS latest
 FROM cdw_formal_approval_instances a
 JOIN cdw_approval_subjects sub ON sub.id=a.subject_id
 WHERE EXISTS(SELECT 1 FROM cdw_business_role_bindings b
  JOIN users u ON u.id=b.user_id
  WHERE b.user_id=$1 AND b.role='document_control'
   AND (b.file_id=sub.file_id OR b.file_id IS NULL)
   AND b.department_id IS NULL AND b.revoked_at IS NULL AND u.disabled_at IS NULL
   AND b.valid_from<=clock_timestamp() AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp()))
 GROUP BY sub.file_id ORDER BY latest DESC,sub.file_id LIMIT $2
 )
 SELECT scoped.file_id,COALESCE(f.name,''),
 (SELECT count(*) FROM cdw_formal_approval_instances a
  JOIN cdw_approval_subjects s ON s.id=a.subject_id WHERE s.file_id=scoped.file_id),
 (SELECT count(*) FROM cdw_formal_approval_instances a JOIN cdw_approval_subjects s ON s.id=a.subject_id
  WHERE s.file_id=scoped.file_id AND a.state='conflicted'
   AND (EXISTS(SELECT 1 FROM cdw_qms_formal_policy_interruptions i WHERE i.approval_instance_id=a.id)
    OR EXISTS(SELECT 1 FROM cdw_qms_formal_legacy_holds h WHERE h.approval_instance_id=a.id))),
 (SELECT count(*) FROM cdw_qms_formal_restarts link WHERE link.file_id=scoped.file_id),
 (SELECT count(*) FROM cdw_formal_approval_instances a JOIN cdw_approval_subjects s ON s.id=a.subject_id
  WHERE s.file_id=scoped.file_id AND a.state='pending'),
 (SELECT count(*) FROM cdw_formal_approval_instances a JOIN cdw_approval_subjects s ON s.id=a.subject_id
  WHERE s.file_id=scoped.file_id AND a.state='approved'),
 (SELECT count(*) FROM cdw_qms_formal_interruption_alerts n
  JOIN cdw_formal_approval_instances a ON a.id=n.approval_instance_id
  JOIN cdw_approval_subjects s ON s.id=a.subject_id
  WHERE s.file_id=scoped.file_id AND n.read_at IS NULL),scoped.latest
 FROM scoped JOIN files f ON f.id=scoped.file_id AND f.deleted_at IS NULL
 ORDER BY scoped.latest DESC,scoped.file_id`, actor, limit+1)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var item ports.CDWQMSPortfolioItem
		var at time.Time
		if err = rows.Scan(&item.FileID, &item.FileName, &item.Approvals, &item.Interrupted,
			&item.Restarts, &item.Pending, &item.Approved, &item.UnconfirmedNotices, &at); err != nil {
			return out, err
		}
		item.LastActivityAt = at.UTC().Format(time.RFC3339Nano)
		out.Items = append(out.Items, item)
	}
	if err = rows.Err(); err != nil {
		return out, err
	}
	if len(out.Items) > limit {
		out.HasMore = true
		out.Items = out.Items[:limit]
	}
	return out, nil
}
