package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type Repository struct{ DB *pgxpool.Pool }

func New(db *pgxpool.Pool) *Repository               { return &Repository{DB: db} }
func (r *Repository) Ping(ctx context.Context) error { return r.DB.Ping(ctx) }
func (r *Repository) UserByLogin(ctx context.Context, login string) (domain.User, string, error) {
	var u domain.User
	var hash string
	err := r.DB.QueryRow(ctx,
		"SELECT id,login,display_name,password_hash,is_admin,must_change_password FROM users WHERE login=$1 AND disabled_at IS NULL", login).
		Scan(&u.ID, &u.Login, &u.DisplayName, &hash, &u.IsAdmin, &u.MustChangePassword)
	return u, hash, err
}
func (r *Repository) InsertSession(ctx context.Context, hash, userID string, expiry time.Time) error {
	_, err := r.DB.Exec(ctx,
		"INSERT INTO sessions(sid_hash,user_id,expires_at) VALUES($1,$2,$3)", hash, userID, expiry)
	return err
}
func (r *Repository) UserBySessionHash(ctx context.Context, hash string) (domain.Authenticated, error) {
	var a domain.Authenticated
	err := r.DB.QueryRow(ctx,
		"SELECT u.id,u.login,u.display_name,u.is_admin,u.must_change_password,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.sid_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.disabled_at IS NULL", hash).
		Scan(&a.User.ID, &a.User.Login, &a.User.DisplayName, &a.User.IsAdmin, &a.User.MustChangePassword, &a.ExpiresAt)
	return a, err
}
func (r *Repository) RevokeSession(ctx context.Context, hash string) error {
	tag, err := r.DB.Exec(ctx, "UPDATE sessions SET revoked_at=now() WHERE sid_hash=$1 AND revoked_at IS NULL", hash)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}
func (r *Repository) ListVisibleFolders(ctx context.Context, u domain.User) ([]domain.Folder, error) {
	var rows pgx.Rows
	var err error
	if u.IsAdmin {
		rows, err = r.DB.Query(ctx, "SELECT id,name,parent_id FROM folders WHERE deleted_at IS NULL ORDER BY name,id LIMIT 200")
	} else {
		// Single query resolves entire ancestral chain + group memberships, rather than N+1 ACL requests.
		// Recursion depth bound protects malformed cyclic input. Higher-scale closure table is later gate.
		query := "WITH RECURSIVE ancestry AS (" +
			" SELECT f.id child,f.id ancestor,f.parent_id,0 depth FROM folders f WHERE f.deleted_at IS NULL" +
			" UNION ALL SELECT a.child,p.id,p.parent_id,a.depth+1 FROM ancestry a" +
			" JOIN folders p ON p.id=a.parent_id WHERE a.depth<64 AND p.deleted_at IS NULL" +
			"), visible AS (" +
			" SELECT DISTINCT a.child FROM ancestry a JOIN acls g ON g.folder_id=a.ancestor" +
			" WHERE (NOT g.scope_only OR a.depth=0) AND (g.expires_at IS NULL OR g.expires_at>now())" +
			" AND 'list'=ANY(g.actions) AND (" +
			" (g.subject_kind='user' AND g.subject_id=$1) OR" +
			" (g.subject_kind='group' AND EXISTS(SELECT 1 FROM workgroup_members wm WHERE wm.group_id=g.subject_id AND wm.user_id=$1))" +
			" )) SELECT f.id,f.name,f.parent_id FROM folders f JOIN visible v ON v.child=f.id" +
			" WHERE f.deleted_at IS NULL ORDER BY f.name,f.id LIMIT 200"
		rows, err = r.DB.Query(ctx, query, u.ID)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Folder, 0)
	for rows.Next() {
		var f domain.Folder
		if err := rows.Scan(&f.ID, &f.Name, &f.ParentID); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

var _ = errors.Is
