package postgres

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
)

func (r *Repository) ListDocumentAudit(ctx context.Context, f domain.DocumentAuditFilter) ([]domain.PermissionAuditRecord, error) {
	query := `SELECT a.id,coalesce(a.actor_id,''),coalesce(u.display_name,''),a.request_id,a.event_type,a.target_kind,a.target_id,a.outcome,a.details,a.created_at
 FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id WHERE ($1::bigint=0 OR a.id<$1)
 AND (a.target_kind IN ('file','trash','folder') OR a.event_type LIKE 'office.%' OR a.event_type LIKE 'approval.%')
 AND ($3='' OR a.actor_id=$3)
 AND ($4='' OR a.event_type LIKE $4||'%')
 ORDER BY a.id DESC LIMIT $5`
	if f.FileID != "" {
		// Start with three selective indexed sources, then combine event IDs.
		// Scanning the global audit ID order causes O(all events) work for
		// ordinary files with few historical changes.
		query = `WITH matching AS (
          SELECT id FROM audit_events WHERE target_kind='file' AND target_id=$2
            AND ($1::bigint=0 OR id<$1)
          UNION
          SELECT a.id FROM trash_entries t JOIN audit_events a
            ON a.target_kind='trash' AND a.target_id=t.id
          WHERE t.file_id=$2 AND ($1::bigint=0 OR a.id<$1)
          UNION
          SELECT l.event_id FROM file_audit_links l WHERE l.file_id=$2
            AND ($1::bigint=0 OR l.event_id<$1)
        )
        SELECT a.id,coalesce(a.actor_id,''),coalesce(u.display_name,''),
          a.request_id,a.event_type,a.target_kind,a.target_id,a.outcome,
          a.details,a.created_at FROM matching m
        JOIN audit_events a ON a.id=m.id
        LEFT JOIN users u ON u.id=a.actor_id
        WHERE ($3='' OR a.actor_id=$3) AND ($4='' OR a.event_type LIKE $4||'%')
        ORDER BY a.id DESC LIMIT $5`
	}
	rows, err := r.Q.Query(ctx, query, f.BeforeID, f.FileID, f.ActorID, f.EventPrefix, f.Limit)
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
