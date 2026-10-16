package postgres

import (
	"context"
	"encoding/json"
	"filesmanage/internal/ports"
	"time"
)

func (r *Repository) CDWActivationHistory(ctx context.Context, releaseID string, limit int) ([]ports.CDWActivationAttempt, error) {
	rows, err := r.Q.Query(ctx, `SELECT id,release_id,COALESCE(actor_id,''),outcome,
 trigger_kind,attempted_at,blockers FROM cdw_activation_attempts
 WHERE release_id=$1 ORDER BY attempted_at DESC,id DESC LIMIT $2`, releaseID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWActivationAttempt{}
	for rows.Next() {
		var item ports.CDWActivationAttempt
		var attemptedAt time.Time
		var blockers []byte
		if err = rows.Scan(&item.ID, &item.ReleaseID, &item.ActorID, &item.Outcome,
			&item.TriggerKind, &attemptedAt, &blockers); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(blockers, &item.Blockers); err != nil {
			return nil, err
		}
		item.AttemptedAt = attemptedAt.UTC().Format(time.RFC3339Nano)
		out = append(out, item)
	}
	return out, rows.Err()
}
