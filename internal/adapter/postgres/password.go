package postgres

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
)

func (r *Repository) ChangePassword(ctx context.Context, userID, oldHash, newHash, keepSessionHash string) error {
	tx, err := r.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	result, err := tx.Exec(ctx, "UPDATE users SET password_hash=$1,must_change_password=false WHERE id=$2 AND password_hash=$3 AND disabled_at IS NULL", newHash, userID, oldHash)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errors.New("password changed concurrently or account disabled")
	}
	if _, err = tx.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1 AND sid_hash<>$2", userID, keepSessionHash); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}

var _ = pgx.ErrNoRows
