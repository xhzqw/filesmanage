package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"time"
)

// ---------- organization (admin-managed identity data) ----------

func scanUserRows(rows pgx.Rows) ([]domain.User, error) {
	out := make([]domain.User, 0)
	for rows.Next() {
		var u domain.User
		var dept *string
		if err := rows.Scan(&u.ID, &u.Login, &u.DisplayName, &u.IsAdmin, &u.MustChangePassword, &dept, &u.DisabledAt); err != nil {
			return nil, err
		}
		if dept != nil {
			u.DepartmentID = *dept
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

const userListSelect = "SELECT id,login,display_name,is_admin,must_change_password,department_id,disabled_at FROM users"

func (r *Repository) ListUsers(ctx context.Context) ([]domain.User, error) {
	rows, err := r.Q.Query(ctx, userListSelect+" ORDER BY created_at,id LIMIT 1000")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanUserRows(rows)
}

func (r *Repository) UserByID(ctx context.Context, id string) (domain.User, error) {
	rows, err := r.Q.Query(ctx, userListSelect+" WHERE id=$1", id)
	if err != nil {
		return domain.User{}, err
	}
	defer rows.Close()
	users, err := scanUserRows(rows)
	if err != nil {
		return domain.User{}, err
	}
	if len(users) == 0 {
		return domain.User{}, ports.ErrRowMissing
	}
	return users[0], nil
}

func (r *Repository) CreateUser(ctx context.Context, u domain.User, passwordHash string) error {
	var department *string
	if u.DepartmentID != "" {
		department = &u.DepartmentID
	}
	_, err := r.Q.Exec(ctx,
		"INSERT INTO users(id,login,display_name,password_hash,is_admin,must_change_password,department_id) VALUES($1,$2,$3,$4,$5,true,$6)",
		u.ID, u.Login, u.DisplayName, passwordHash, u.IsAdmin, department)
	if isUniqueViolation(err) {
		return domain.ErrNameConflict
	}
	if isForeignKeyViolation(err) {
		return domain.ErrInvalidInput
	}
	return err
}

func (r *Repository) SetUserPassword(ctx context.Context, userID, passwordHash string) error {
	tag, err := r.Q.Exec(ctx, "UPDATE users SET password_hash=$2 WHERE id=$1", userID, passwordHash)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ports.ErrRowMissing
	}
	// A credential reset invalidates every existing session for that account.
	_, err = r.Q.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1", userID)
	return err
}

func isForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}

func (r *Repository) SetUserDepartment(ctx context.Context, userID string, departmentID *string) error {
	tag, err := r.Q.Exec(ctx, "UPDATE users SET department_id=$2 WHERE id=$1", userID, departmentID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ports.ErrRowMissing
	}
	return nil
}

func (r *Repository) SetUserDisabled(ctx context.Context, userID string, disabled bool) error {
	var tag pgconn.CommandTag
	var err error
	if disabled {
		tag, err = r.Q.Exec(ctx, "UPDATE users SET disabled_at=now() WHERE id=$1 AND disabled_at IS NULL", userID)
		if err == nil && tag.RowsAffected() == 1 {
			_, err = r.Q.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1", userID)
		}
	} else {
		tag, err = r.Q.Exec(ctx, "UPDATE users SET disabled_at=NULL WHERE id=$1 AND disabled_at IS NOT NULL", userID)
	}
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ports.ErrRowMissing
	}
	return nil
}

func (r *Repository) ForcePasswordChange(ctx context.Context, userID string) error {
	tag, err := r.Q.Exec(ctx, "UPDATE users SET must_change_password=true WHERE id=$1", userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ports.ErrRowMissing
	}
	return nil
}

func (r *Repository) ListDepartments(ctx context.Context) ([]domain.Department, error) {
	rows, err := r.Q.Query(ctx, "SELECT id,name,parent_id FROM departments ORDER BY name,id LIMIT 1000")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Department, 0)
	for rows.Next() {
		var d domain.Department
		if err := rows.Scan(&d.ID, &d.Name, &d.ParentID); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (r *Repository) CreateDepartment(ctx context.Context, d domain.Department) error {
	_, err := r.Q.Exec(ctx, "INSERT INTO departments(id,name,parent_id) VALUES($1,$2,$3)", d.ID, d.Name, d.ParentID)
	if isUniqueViolation(err) {
		return domain.ErrNameConflict
	}
	return err
}

func (r *Repository) RenameDepartment(ctx context.Context, id, name string) error {
	tag, err := r.Q.Exec(ctx, "UPDATE departments SET name=$2 WHERE id=$1", id, name)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ports.ErrRowMissing
	}
	return nil
}

func (r *Repository) ListWorkgroups(ctx context.Context) ([]domain.Workgroup, error) {
	rows, err := r.Q.Query(ctx, "SELECT id,name,department_id FROM workgroups ORDER BY name,id LIMIT 1000")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Workgroup, 0)
	for rows.Next() {
		var g domain.Workgroup
		if err := rows.Scan(&g.ID, &g.Name, &g.DepartmentID); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

func (r *Repository) WorkgroupByID(ctx context.Context, id string) (domain.Workgroup, error) {
	var g domain.Workgroup
	err := r.Q.QueryRow(ctx, "SELECT id,name,department_id FROM workgroups WHERE id=$1", id).
		Scan(&g.ID, &g.Name, &g.DepartmentID)
	if err != nil {
		return domain.Workgroup{}, err
	}
	return g, nil
}

func (r *Repository) CreateWorkgroup(ctx context.Context, g domain.Workgroup) error {
	_, err := r.Q.Exec(ctx, "INSERT INTO workgroups(id,department_id,name) VALUES($1,$2,$3)", g.ID, g.DepartmentID, g.Name)
	if isUniqueViolation(err) {
		return domain.ErrNameConflict
	}
	return err
}

func (r *Repository) RenameWorkgroup(ctx context.Context, id, name string) error {
	tag, err := r.Q.Exec(ctx, "UPDATE workgroups SET name=$2 WHERE id=$1", id, name)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ports.ErrRowMissing
	}
	return nil
}

func (r *Repository) WorkgroupMembers(ctx context.Context, groupID string) ([]domain.User, error) {
	rows, err := r.Q.Query(ctx,
		userListSelect+" WHERE id IN (SELECT user_id FROM workgroup_members WHERE group_id=$1) ORDER BY login", groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanUserRows(rows)
}

func (r *Repository) AddWorkgroupMember(ctx context.Context, groupID, userID string) error {
	tag, err := r.Q.Exec(ctx,
		"INSERT INTO workgroup_members(group_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", groupID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrConflict
	}
	return nil
}

func (r *Repository) RemoveWorkgroupMember(ctx context.Context, groupID, userID string) error {
	tag, err := r.Q.Exec(ctx, "DELETE FROM workgroup_members WHERE group_id=$1 AND user_id=$2", groupID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ports.ErrRowMissing
	}
	return nil
}

var _ = time.Now
var _ = errors.Is
