package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
	"strings"
)

// Session inventory never returns token hashes. The 96-bit public ID prefix is
// a selector only and cannot be supplied as an authentication credential.
func (r *Repository) SetSessionMetadata(ctx context.Context, hash, address, mac, device string) error {
	_, err := r.Q.Exec(ctx, "UPDATE sessions SET client_ip=$2,mac_address=$3,device_label=$4 WHERE sid_hash=$1", hash, address, mac, device)
	return err
}
func (r *Repository) TouchSession(ctx context.Context, hash string) error {
	_, err := r.Q.Exec(ctx, `UPDATE sessions SET last_seen_at=now() WHERE sid_hash=$1 AND revoked_at IS NULL
 AND expires_at>now() AND last_seen_at<now()-interval '60 seconds'`, hash)
	return err
}
func (r *Repository) SessionOwner(ctx context.Context, hash string) (string, error) {
	var id string
	err := r.Q.QueryRow(ctx, "SELECT user_id FROM sessions WHERE sid_hash=$1 AND revoked_at IS NULL", hash).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ports.ErrRowMissing
	}
	return id, err
}
func (r *Repository) ListOwnSessions(ctx context.Context, userID, currentHash string) ([]ports.SessionRow, error) {
	rows, err := r.Q.Query(ctx, `SELECT left(sid_hash,24),device_label,client_ip,mac_address,created_at,last_seen_at,expires_at
 FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()
 ORDER BY (sid_hash=$2) DESC,created_at DESC,sid_hash DESC LIMIT 50`, userID, currentHash)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]ports.SessionRow, 0, 8)
	for rows.Next() {
		var row ports.SessionRow
		if err = rows.Scan(&row.ID, &row.Device, &row.Address, &row.MACAddress, &row.CreatedAt, &row.LastSeenAt, &row.ExpiresAt); err != nil {
			return nil, err
		}
		items = append(items, row)
	}
	return items, rows.Err()
}
func (r *Repository) RevokeOwnSession(ctx context.Context, userID, id, currentHash string) (bool, error) {
	if len(id) != 24 || strings.Trim(id, "0123456789abcdef") != "" {
		return false, nil
	}
	tag, err := r.Q.Exec(ctx, `UPDATE sessions SET revoked_at=now()
 WHERE user_id=$1 AND left(sid_hash,24)=$2 AND sid_hash<>$3
 AND revoked_at IS NULL AND expires_at>now()`, userID, id, currentHash)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}
func (r *Repository) RevokeOtherSessions(ctx context.Context, userID, currentHash string) (int64, error) {
	tag, err := r.Q.Exec(ctx, `UPDATE sessions SET revoked_at=now()
 WHERE user_id=$1 AND sid_hash<>$2 AND revoked_at IS NULL AND expires_at>now()`, userID, currentHash)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
func (r *Repository) ListOwnAuthActivity(ctx context.Context, userID string) ([]ports.AuthActivity, error) {
	rows, err := r.Q.Query(ctx, `SELECT event_type,outcome,
 coalesce(details->>'device',''),coalesce(details->>'ip',''),coalesce(details->>'mac',''),coalesce((details->>'count')::integer,0),created_at
 FROM audit_events WHERE actor_id=$1 AND event_type IN
 ('auth.login','auth.logout','auth.session_revoke','auth.sessions_revoke')
 ORDER BY created_at DESC,id DESC LIMIT 30`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]ports.AuthActivity, 0, 12)
	for rows.Next() {
		var row ports.AuthActivity
		if err = rows.Scan(&row.Type, &row.Outcome, &row.Device, &row.Address, &row.MACAddress, &row.Count, &row.OccurredAt); err != nil {
			return nil, err
		}
		items = append(items, row)
	}
	return items, rows.Err()
}
