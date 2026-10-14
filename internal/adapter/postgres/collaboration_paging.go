package postgres

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

// A stable descending (created_at, id) keyset prevents duplicate/omitted
// records when newly created rows arrive between page requests.
func scanSharePage(ctx context.Context, r *Repository, sql string, args ...any) ([]domain.Share, error) {
	rows, err := r.Q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Share, 0)
	for rows.Next() {
		v, err := scanShare(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (r *Repository) PageSharesForSubject(ctx context.Context, userID string, groups []string, after ports.CollaborationCursor, limit int) ([]domain.Share, error) {
	return scanSharePage(ctx, r, shareSelect+` WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>now())
 AND ((s.recipient_kind='user' AND s.recipient_id=$1) OR (s.recipient_kind='group' AND s.recipient_id=ANY($2::text[])))
 AND ($3='' OR (s.created_at,s.id)<($4,$3))
 ORDER BY s.created_at DESC,s.id DESC LIMIT $5`, userID, groups, after.ID, after.CreatedAt, limit)
}
func (r *Repository) PageSharesCreatedBy(ctx context.Context, userID string, after ports.CollaborationCursor, limit int) ([]domain.Share, error) {
	return scanSharePage(ctx, r, shareSelect+` WHERE s.created_by=$1
 AND ($2='' OR (s.created_at,s.id)<($3,$2))
 ORDER BY s.created_at DESC,s.id DESC LIMIT $4`, userID, after.ID, after.CreatedAt, limit)
}
func (r *Repository) PageFavorites(ctx context.Context, userID string, after ports.CollaborationCursor, limit int) ([]domain.Favorite, error) {
	rows, err := r.Q.Query(ctx, favoriteSelect+` WHERE fa.user_id=$1
 AND ($2='' OR (fa.created_at,fa.id)<($3,$2))
 ORDER BY fa.created_at DESC,fa.id DESC LIMIT $4`, userID, after.ID, after.CreatedAt, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Favorite, 0)
	for rows.Next() {
		v, err := scanFavorite(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
