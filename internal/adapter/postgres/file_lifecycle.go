package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

func (r *Repository) FileLifecycleByID(ctx context.Context, id string) (domain.FileLifecycle, error) {
	var value domain.FileLifecycle
	err := r.Q.QueryRow(ctx, `SELECT file_id,state,published_seq,published_at,published_by,due_at,note,updated_at
 FROM file_lifecycle WHERE file_id=$1`, id).Scan(&value.FileID, &value.State, &value.PublishedSeq, &value.PublishedAt, &value.PublishedBy, &value.DueAt, &value.Note, &value.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.FileLifecycle{}, ports.ErrRowMissing
	}
	return value, err
}
func (r *Repository) UpsertFileLifecycle(ctx context.Context, value domain.FileLifecycle) error {
	_, err := r.Q.Exec(ctx, `INSERT INTO file_lifecycle(file_id,state,published_seq,published_at,published_by,due_at,note,updated_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,now())
 ON CONFLICT(file_id) DO UPDATE SET state=EXCLUDED.state,published_seq=EXCLUDED.published_seq,
 published_at=EXCLUDED.published_at,published_by=EXCLUDED.published_by,due_at=EXCLUDED.due_at,
 note=EXCLUDED.note,updated_at=now()`, value.FileID, value.State, value.PublishedSeq, value.PublishedAt, value.PublishedBy, value.DueAt, value.Note)
	return err
}
