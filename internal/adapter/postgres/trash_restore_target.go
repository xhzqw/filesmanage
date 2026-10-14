package postgres

import (
	"context"
	"filesmanage/internal/domain"
	"github.com/jackc/pgx/v5"
)

// RestoreFileTo updates the name and destination while lifting the deletion
// marker. A separate rename/move would fail for an inactive row.
func (r *Repository) RestoreFileTo(ctx context.Context, id, folderID, name string) error {
	tag, err := r.Q.Exec(ctx, `UPDATE files SET deleted_at=NULL,folder_id=$2,name=$3,updated_at=now()
  WHERE id=$1 AND deleted_at IS NOT NULL`, id, folderID, name)
	if err != nil {
		if isUniqueViolation(err) {
			return domain.ErrNameConflict
		}
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func (r *Repository) RestoreFolderTo(ctx context.Context, id, parentID, name string) error {
	tag, err := r.Q.Exec(ctx, `UPDATE folders SET deleted_at=NULL,parent_id=$2,name=$3,updated_at=now()
  WHERE id=$1 AND deleted_at IS NOT NULL`, id, parentID, name)
	if err != nil {
		if isUniqueViolation(err) {
			return domain.ErrNameConflict
		}
		if isCheckViolation(err) {
			return domain.ErrInvalidInput
		}
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}
