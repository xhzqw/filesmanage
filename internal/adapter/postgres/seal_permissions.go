package postgres

import (
	"context"
	"filesmanage/internal/domain"
)

// Sign and stamp authorities are distinct, deny-by-default permissions.
// A new user without a row is never authorized.
func (r *Repository) ListSealUserPermissions(ctx context.Context) ([]domain.SealUserPermission, error) {
	rows, err := r.Q.Query(ctx, `SELECT u.id,u.display_name,COALESCE(p.can_sign,false),COALESCE(p.can_stamp,false)
  FROM users u LEFT JOIN seal_user_permissions p ON p.user_id=u.id
  WHERE u.disabled_at IS NULL ORDER BY u.is_admin DESC,u.display_name,u.id LIMIT 500`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.SealUserPermission{}
	for rows.Next() {
		var v domain.SealUserPermission
		if err = rows.Scan(&v.UserID, &v.DisplayName, &v.CanSign, &v.CanStamp); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (r *Repository) SealUserPermission(ctx context.Context, userID string) (domain.SealUserPermission, error) {
	var v domain.SealUserPermission
	err := r.Q.QueryRow(ctx, `SELECT u.id,u.display_name,COALESCE(p.can_sign,false),COALESCE(p.can_stamp,false)
  FROM users u LEFT JOIN seal_user_permissions p ON p.user_id=u.id
  WHERE u.id=$1 AND u.disabled_at IS NULL`, userID).Scan(&v.UserID, &v.DisplayName, &v.CanSign, &v.CanStamp)
	return v, err
}

func (r *Repository) SetSealUserPermission(ctx context.Context, userID string, canSign, canStamp bool, adminID string) error {
	tag, err := r.Q.Exec(ctx, `INSERT INTO seal_user_permissions(user_id,can_sign,can_stamp,updated_by)
 SELECT u.id,$2,$3,$4 FROM users u WHERE u.id=$1 AND u.disabled_at IS NULL
 ON CONFLICT (user_id) DO UPDATE SET can_sign=EXCLUDED.can_sign,can_stamp=EXCLUDED.can_stamp,
 updated_by=EXCLUDED.updated_by,updated_at=now()`, userID, canSign, canStamp, adminID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return domain.ErrNotFound
	}
	return nil
}

func (r *Repository) RenameSeal(ctx context.Context, id, name string) error {
	tag, err := r.Q.Exec(ctx, `UPDATE seal_assets SET name=$2 WHERE id=$1 AND retired_at IS NULL`, id, name)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return domain.ErrNotFound
	}
	return nil
}

// Uses a separate index lookup so UI can signal duplicate use before password
// submission; uniqueness remains enforced in PostgreSQL at commit time.
func (r *Repository) FileHasSeal(ctx context.Context, fileID, assetID string) (bool, error) {
	var found bool
	err := r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM file_seal_marks m JOIN seal_assets a ON a.id=$2 WHERE m.file_id=$1 AND (m.asset_id=a.id OR m.asset_sha256=a.sha256))`, fileID, assetID).Scan(&found)
	return found, err
}
