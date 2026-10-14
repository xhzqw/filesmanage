package postgres

import (
	"context"
	"filesmanage/internal/domain"
)

// RealtimeBounds returns the oldest safe replay boundary and newest known
// cursor, including the persisted prune watermark. The watermark matters when
// retention emptied the journal or removed older rows non-contiguously.
func (r *Repository) RealtimeBounds(ctx context.Context) (oldest, newest int64, err error) {
	err = r.DB.QueryRow(ctx, `SELECT
	GREATEST(COALESCE((SELECT id FROM realtime_events ORDER BY id ASC LIMIT 1),0),
	         (SELECT last_pruned_id+1 FROM realtime_retention WHERE singleton=true)),
	GREATEST(COALESCE((SELECT id FROM realtime_events ORDER BY id DESC LIMIT 1),0),
	         (SELECT last_pruned_id FROM realtime_retention WHERE singleton=true))`).Scan(&oldest, &newest)
	return
}

// RealtimeAfter may only return public invalidations or events owned by the
// authenticated subscriber. The cursor is non-secret and never grants access.
func (r *Repository) RealtimeAfter(ctx context.Context, userID string, cursor int64, limit int) ([]domain.RealtimeEvent, error) {
	// Two ordered index-only starting points avoid scanning unrelated private
	// users when one tenant generates a high volume of personal notifications.
	rows, err := r.DB.Query(ctx, `SELECT id,event_type,scopes FROM (
	 (SELECT id,event_type,scopes FROM realtime_events
	  WHERE id>$1 AND user_id IS NULL ORDER BY id LIMIT $3)
	 UNION ALL
	 (SELECT id,event_type,scopes FROM realtime_events
	  WHERE id>$1 AND user_id=$2 ORDER BY id LIMIT $3)
	) relevant ORDER BY id LIMIT $3`, cursor, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.RealtimeEvent, 0)
	for rows.Next() {
		var event domain.RealtimeEvent
		if err := rows.Scan(&event.ID, &event.Type, &event.Scopes); err != nil {
			return nil, err
		}
		out = append(out, event)
	}
	return out, rows.Err()
}

// RealtimeFeedAfter is an internal-only, all-target journal read. It is never
// reachable from HTTP/WS. Replica processes need recipient IDs solely to
// evict affected session caches after credential revocation elsewhere.
func (r *Repository) RealtimeFeedAfter(ctx context.Context, cursor int64, limit int) ([]domain.RealtimeEvent, error) {
	rows, err := r.DB.Query(ctx, `SELECT id,COALESCE(user_id,''),event_type,scopes
	 FROM realtime_events WHERE id>$1 ORDER BY id LIMIT $2`, cursor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.RealtimeEvent, 0)
	for rows.Next() {
		var event domain.RealtimeEvent
		if err := rows.Scan(&event.ID, &event.UserID, &event.Type, &event.Scopes); err != nil {
			return nil, err
		}
		out = append(out, event)
	}
	return out, rows.Err()
}

// PruneRealtimeEvents has a fixed deletion budget so the operator's retention
// run never locks the journal for an unbounded period. The client detects an
// expired replay window via RealtimeBounds and performs full reconciliation.
func (r *Repository) PruneRealtimeEvents(ctx context.Context, days int, batch int) (int64, error) {
	if days < 1 || batch < 1 || batch > 5000 {
		return 0, nil
	}
	var deleted int64
	err := r.DB.QueryRow(ctx, `WITH deleted AS (
	 DELETE FROM realtime_events WHERE id IN (
	  SELECT id FROM realtime_events
	  WHERE created_at<now()-($1::integer * INTERVAL '1 day')
	  ORDER BY created_at,id LIMIT $2
	 ) RETURNING id
	), advanced AS (
	 INSERT INTO realtime_retention(singleton,last_pruned_id)
	 SELECT true,max(id) FROM deleted HAVING count(*)>0
	 ON CONFLICT(singleton) DO UPDATE SET
	 last_pruned_id=GREATEST(realtime_retention.last_pruned_id,EXCLUDED.last_pruned_id)
	 RETURNING last_pruned_id
	)
	SELECT count(*) FROM deleted`, days, batch).Scan(&deleted)
	if err != nil {
		return 0, err
	}
	return deleted, nil
}
