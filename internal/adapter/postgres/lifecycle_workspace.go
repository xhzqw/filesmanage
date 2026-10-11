package postgres

import (
	"context"
	"filesmanage/internal/domain"
	"time"
)

func (r *Repository) ListLifecycleLedger(ctx context.Context, after, state string, limit int, now time.Time) ([]domain.LifecycleLedgerRow, error) {
	rows, err := r.Q.Query(ctx, `SELECT l.file_id,f.name,f.folder_id,l.state,l.published_seq,l.due_at,l.retention_until
 FROM file_lifecycle l JOIN files f ON f.id=l.file_id
 WHERE l.file_id>$1 AND f.deleted_at IS NULL
 AND ($2='' OR l.state=$2)
 ORDER BY l.file_id LIMIT $3`, after, state, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.LifecycleLedgerRow, 0, limit)
	for rows.Next() {
		var v domain.LifecycleLedgerRow
		if err = rows.Scan(&v.FileID, &v.FileName, &v.FolderID, &v.State, &v.PublishedSeq, &v.DueAt, &v.RetentionUntil); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (r *Repository) ListLifecycleNotifications(ctx context.Context, userID string) ([]domain.LifecycleNotification, error) {
	rows, err := r.Q.Query(ctx, `SELECT n.id,n.file_id,f.name,n.kind,n.due_at,n.created_at,n.read_at IS NOT NULL
 FROM lifecycle_notifications n JOIN files f ON f.id=n.file_id JOIN file_lifecycle l ON l.file_id=f.id
 WHERE n.recipient_id=$1 AND f.deleted_at IS NULL AND l.due_at=n.due_at
 ORDER BY n.id DESC LIMIT 100`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.LifecycleNotification, 0)
	for rows.Next() {
		var v domain.LifecycleNotification
		if err = rows.Scan(&v.ID, &v.FileID, &v.FileName, &v.Kind, &v.DueAt, &v.CreatedAt, &v.Read); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (r *Repository) ReadLifecycleNotification(ctx context.Context, userID string, id int64) (bool, error) {
	tag, err := r.Q.Exec(ctx, `UPDATE lifecycle_notifications SET read_at=coalesce(read_at,now())
 WHERE id=$1 AND recipient_id=$2`, id, userID)
	return tag.RowsAffected() > 0, err
}
func (r *Repository) HasProtectedLifecycleInFolders(ctx context.Context, folders []string, now time.Time) (bool, error) {
	var exists bool
	err := r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM file_lifecycle l
 JOIN files f ON f.id=l.file_id
 WHERE f.folder_id=ANY($1::text[]) AND f.deleted_at IS NULL
 AND (l.state='archived' OR l.retention_until>$2))`, folders, now).Scan(&exists)
	return exists, err
}

// Invoked at server startup and hourly. Constraint makes overlapping runs
// idempotent, including restarts and multiple server instances.
func (r *Repository) GenerateLifecycleNotifications(ctx context.Context, now time.Time) (int64, error) {
	tag, err := r.Q.Exec(ctx, `INSERT INTO lifecycle_notifications(file_id,recipient_id,due_at,kind)
 SELECT l.file_id,l.published_by,l.due_at,
 CASE WHEN l.due_at<=$1 THEN 'overdue' ELSE 'soon' END
 FROM file_lifecycle l JOIN files f ON f.id=l.file_id
 JOIN users u ON u.id=l.published_by
 WHERE l.due_at IS NOT NULL AND l.due_at<=$1+interval '7 days'
 AND f.deleted_at IS NULL AND u.disabled_at IS NULL
 ON CONFLICT (file_id,recipient_id,due_at,kind) DO NOTHING`, now)
	return tag.RowsAffected(), err
}
