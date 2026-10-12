package postgres

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
)

func (r *Repository) ListDocumentAudit(ctx context.Context, f domain.DocumentAuditFilter) ([]domain.PermissionAuditRecord, error) {
	rows, err := r.Q.Query(ctx, `SELECT a.id,coalesce(a.actor_id,''),coalesce(u.display_name,''),a.request_id,a.event_type,a.target_kind,a.target_id,a.outcome,a.details,a.created_at
 FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id WHERE ($1::bigint=0 OR a.id<$1)
 AND (a.target_kind IN ('file','trash','folder') OR a.event_type LIKE 'office.%' OR a.event_type LIKE 'approval.%')
 AND ($2='' OR (a.target_kind='file' AND a.target_id=$2)
      OR (a.target_kind='trash' AND EXISTS
          (SELECT 1 FROM trash_entries t WHERE t.id=a.target_id AND t.file_id=$2))
      OR EXISTS(SELECT 1 FROM file_audit_links l WHERE l.event_id=a.id AND l.file_id=$2))
 AND ($3='' OR a.actor_id=$3)
 AND ($4='' OR a.event_type LIKE $4||'%')
 ORDER BY a.id DESC LIMIT $5`, f.BeforeID, f.FileID, f.ActorID, f.EventPrefix, f.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.PermissionAuditRecord, 0, f.Limit)
	for rows.Next() {
		var row domain.PermissionAuditRecord
		var details []byte
		if err = rows.Scan(&row.ID, &row.ActorID, &row.ActorName, &row.RequestID, &row.EventType, &row.TargetKind, &row.TargetID, &row.Outcome, &details, &row.CreatedAt); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(details, &row.Details); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
