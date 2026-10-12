package postgres

import (
	"context"
	"filesmanage/internal/domain"
)

// RealtimeBounds uses the indexed primary key to find the oldest retained
// cursor and the latest committed cursor. Journal inserts are serialized by
// an advisory transaction lock so IDs follow commit order.
func (r *Repository) RealtimeBounds(ctx context.Context) (oldest, newest int64, err error) {
	err = r.DB.QueryRow(ctx, `SELECT
	COALESCE((SELECT id FROM realtime_events ORDER BY id ASC LIMIT 1),0),
	COALESCE((SELECT id FROM realtime_events ORDER BY id DESC LIMIT 1),0)`).Scan(&oldest, &newest)
	return
}

// RealtimeAfter may only return public invalidations or events owned by the
// authenticated subscriber. The cursor is non-secret and never grants access.
func (r *Repository) RealtimeAfter(ctx context.Context, userID string, cursor int64, limit int) ([]domain.RealtimeEvent, error) {
	rows, err := r.DB.Query(ctx, `SELECT id,event_type,scopes FROM realtime_events
	WHERE id>$1 AND (user_id IS NULL OR user_id=$2)
	ORDER BY id LIMIT $3`, cursor, userID, limit)
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

// PruneRealtimeEvents has a fixed deletion budget so the operator's retention
// run never locks the journal for an unbounded period. The client detects an
// expired replay window via RealtimeBounds and performs full reconciliation.
func (r *Repository) PruneRealtimeEvents(ctx context.Context, days int, batch int) (int64, error) {
	if days < 1 || batch < 1 || batch > 5000 {
		return 0, nil
	}
	result, err := r.DB.Exec(ctx, `DELETE FROM realtime_events WHERE id IN
	(SELECT id FROM realtime_events WHERE created_at<now()-($1::integer * INTERVAL '1 day')
	 ORDER BY created_at,id LIMIT $2)`, days, batch)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected(), nil
}
