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
	err := r.Q.QueryRow(ctx, `SELECT file_id,state,published_seq,published_at,published_by,responsible_id,due_at,retention_until,note,updated_at
 FROM file_lifecycle WHERE file_id=$1`, id).Scan(&value.FileID, &value.State, &value.PublishedSeq, &value.PublishedAt, &value.PublishedBy, &value.ResponsibleID, &value.DueAt, &value.RetentionUntil, &value.Note, &value.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.FileLifecycle{}, ports.ErrRowMissing
	}
	return value, err
}
func (r *Repository) UpsertFileLifecycle(ctx context.Context, value domain.FileLifecycle) error {
	_, err := r.Q.Exec(ctx, `INSERT INTO file_lifecycle(file_id,state,published_seq,published_at,published_by,responsible_id,due_at,retention_until,note,updated_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
 ON CONFLICT(file_id) DO UPDATE SET state=EXCLUDED.state,published_seq=EXCLUDED.published_seq,
 published_at=EXCLUDED.published_at,published_by=EXCLUDED.published_by,due_at=EXCLUDED.due_at,
 responsible_id=EXCLUDED.responsible_id,
 retention_until=CASE
 WHEN file_lifecycle.retention_until IS NULL THEN EXCLUDED.retention_until
 WHEN EXCLUDED.retention_until IS NULL THEN file_lifecycle.retention_until
 ELSE greatest(file_lifecycle.retention_until,EXCLUDED.retention_until) END,
 note=EXCLUDED.note,updated_at=now()`, value.FileID, value.State, value.PublishedSeq, value.PublishedAt, value.PublishedBy, value.ResponsibleID, value.DueAt, value.RetentionUntil, value.Note)
	return err
}
