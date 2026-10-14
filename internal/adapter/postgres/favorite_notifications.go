package postgres

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

func (r *Repository) ListFavoriteNotifications(ctx context.Context, userID string, limit int) ([]domain.FavoriteNotification, int, error) {
	rows, err := r.Q.Query(ctx, `SELECT id,recipient_id,affected_count,created_at,read_at IS NOT NULL
 FROM favorite_notifications WHERE recipient_id=$1 ORDER BY id DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	notes := make([]domain.FavoriteNotification, 0)
	for rows.Next() {
		var n domain.FavoriteNotification
		if err = rows.Scan(&n.ID, &n.RecipientID, &n.AffectedCount, &n.CreatedAt, &n.Read); err != nil {
			return nil, 0, err
		}
		notes = append(notes, n)
	}
	if err = rows.Err(); err != nil {
		return nil, 0, err
	}
	var unread int
	err = r.Q.QueryRow(ctx, `SELECT count(*) FROM favorite_notifications WHERE recipient_id=$1 AND read_at IS NULL`, userID).Scan(&unread)
	return notes, unread, err
}

func (r *Repository) ReadFavoriteNotification(ctx context.Context, userID string, id int64) error {
	tag, err := r.Q.Exec(ctx, `UPDATE favorite_notifications SET read_at=coalesce(read_at,now())
 WHERE recipient_id=$1 AND id=$2`, userID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ports.ErrRowMissing
	}
	return nil
}
