package postgres

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

const roleBindingSelect = `SELECT id,user_id,role,scope_kind,coalesce(scope_id,''),
 allowed_actions,expires_at,granted_by,created_at,revoked_at FROM management_role_bindings`

func readRoleBindings(rows pgx.Rows) ([]domain.ManagementRoleBinding, error) {
	defer rows.Close()
	out := make([]domain.ManagementRoleBinding, 0)
	for rows.Next() {
		var b domain.ManagementRoleBinding
		if err := rows.Scan(&b.ID, &b.UserID, &b.Role, &b.ScopeKind, &b.ScopeID,
			&b.AllowedActions, &b.ExpiresAt, &b.GrantedBy, &b.CreatedAt, &b.RevokedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (r *Repository) ListRoleBindings(ctx context.Context) ([]domain.ManagementRoleBinding, error) {
	rows, err := r.Q.Query(ctx, roleBindingSelect+" WHERE revoked_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1000")
	if err != nil {
		return nil, err
	}
	return readRoleBindings(rows)
}
func (r *Repository) RoleBindingsForUser(ctx context.Context, userID string) ([]domain.ManagementRoleBinding, error) {
	rows, err := r.Q.Query(ctx, roleBindingSelect+" WHERE user_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) ORDER BY created_at DESC LIMIT 1000", userID)
	if err != nil {
		return nil, err
	}
	return readRoleBindings(rows)
}
func (r *Repository) RoleBindingByID(ctx context.Context, id string) (domain.ManagementRoleBinding, error) {
	rows, err := r.Q.Query(ctx, roleBindingSelect+" WHERE id=$1 AND revoked_at IS NULL", id)
	if err != nil {
		return domain.ManagementRoleBinding{}, err
	}
	items, err := readRoleBindings(rows)
	if err != nil {
		return domain.ManagementRoleBinding{}, err
	}
	if len(items) == 0 {
		return domain.ManagementRoleBinding{}, ports.ErrRowMissing
	}
	return items[0], nil
}
func (r *Repository) InsertRoleBinding(ctx context.Context, b domain.ManagementRoleBinding) error {
	var folderID *string
	if b.ScopeID != "" {
		folderID = &b.ScopeID
	}
	_, err := r.Q.Exec(ctx, `INSERT INTO management_role_bindings
 (id,user_id,role,scope_kind,scope_id,allowed_actions,expires_at,granted_by,created_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		b.ID, b.UserID, b.Role, b.ScopeKind, folderID, b.AllowedActions, b.ExpiresAt, b.GrantedBy, b.CreatedAt)
	return err
}
func (r *Repository) RevokeRoleBinding(ctx context.Context, id string) error {
	tag, err := r.Q.Exec(ctx, "UPDATE management_role_bindings SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL", id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ports.ErrRowMissing
	}
	return nil
}
