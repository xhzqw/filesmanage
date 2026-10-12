package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"strings"
	"time"
)

// querier is the common surface of *pgxpool.Pool and pgx.Tx so every method
// works unchanged against either a pool read or a transaction-bound write.
type querier interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, arguments ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, arguments ...any) pgx.Row
}

type rowScanner interface {
	Scan(dest ...any) error
}

type Repository struct {
	DB *pgxpool.Pool
	Q  querier
}

func New(db *pgxpool.Pool) *Repository { return &Repository{DB: db, Q: db} }

// Begin opens the single transaction a write use case must run in.
func (r *Repository) Begin(ctx context.Context) (ports.Tx, error) {
	tx, err := r.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return txHandle{Tx: tx, Repository: &Repository{DB: r.DB, Q: tx}}, nil
}

type txHandle struct {
	Tx pgx.Tx
	*Repository
}

func (t txHandle) Commit(ctx context.Context) error   { return t.Tx.Commit(ctx) }
func (t txHandle) Rollback(ctx context.Context) error { return t.Tx.Rollback(ctx) }

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func isCheckViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23514"
}

func (r *Repository) Ping(ctx context.Context) error {
	if p, ok := r.Q.(interface{ Ping(context.Context) error }); ok {
		return p.Ping(ctx)
	}
	return r.DB.Ping(ctx)
}

func marshalDetails(details map[string]any) string {
	raw, err := json.Marshal(details)
	if err != nil {
		return "{}"
	}
	return string(raw)
}

// ---------- identity ----------

func (r *Repository) UserByLogin(ctx context.Context, login string) (domain.User, string, error) {
	var u domain.User
	var hash string
	var dept *string
	err := r.Q.QueryRow(ctx,
		"SELECT id,login,display_name,password_hash,is_admin,must_change_password,department_id,disabled_at FROM users WHERE login=$1 AND disabled_at IS NULL", login).
		Scan(&u.ID, &u.Login, &u.DisplayName, &hash, &u.IsAdmin, &u.MustChangePassword, &dept, &u.DisabledAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.User{}, "", ports.ErrRowMissing
	}
	if err != nil {
		return domain.User{}, "", err
	}
	if dept != nil {
		u.DepartmentID = *dept
	}
	return u, hash, err
}

func (r *Repository) UserBySessionHash(ctx context.Context, hash string) (domain.Authenticated, error) {
	var a domain.Authenticated
	var dept *string
	err := r.Q.QueryRow(ctx,
		"SELECT u.id,u.login,u.display_name,u.is_admin,u.must_change_password,u.department_id,u.disabled_at,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.sid_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.disabled_at IS NULL", hash).
		Scan(&a.User.ID, &a.User.Login, &a.User.DisplayName, &a.User.IsAdmin, &a.User.MustChangePassword, &dept, &a.User.DisabledAt, &a.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Authenticated{}, ports.ErrRowMissing
	}
	if err != nil {
		return domain.Authenticated{}, err
	}
	if dept != nil {
		a.User.DepartmentID = *dept
	}
	return a, nil
}

func (r *Repository) InsertSession(ctx context.Context, hash, userID string, expiry time.Time) error {
	_, err := r.Q.Exec(ctx, "INSERT INTO sessions(sid_hash,user_id,expires_at) VALUES($1,$2,$3)", hash, userID, expiry)
	return err
}

func (r *Repository) RevokeSession(ctx context.Context, hash string) error {
	tag, err := r.Q.Exec(ctx, "UPDATE sessions SET revoked_at=now() WHERE sid_hash=$1 AND revoked_at IS NULL", hash)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ports.ErrRowMissing
	}
	return nil
}

func (r *Repository) ChangePassword(ctx context.Context, userID, oldHash, newHash, keepSessionHash string) error {
	tag, err := r.Q.Exec(ctx, "UPDATE users SET password_hash=$1,must_change_password=false WHERE id=$2 AND password_hash=$3", newHash, userID, oldHash)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("password changed concurrently or account disabled")
	}
	_, err = r.Q.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1 AND sid_hash<>$2", userID, keepSessionHash)
	return err
}

// ---------- folders ----------

func (r *Repository) ListVisibleFolders(ctx context.Context, u domain.User) ([]domain.Folder, error) {
	var rows pgx.Rows
	var err error
	if u.IsAdmin {
		rows, err = r.Q.Query(ctx, "SELECT id,name,parent_id FROM folders WHERE deleted_at IS NULL ORDER BY name,id LIMIT 500")
	} else {
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
			" WHERE f.deleted_at IS NULL ORDER BY f.name,f.id LIMIT 500"
		rows, err = r.Q.Query(ctx, query, u.ID)
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
	return out, rows.Err()
}

// ---------- paged folder reads (COMPLEX-WORKFLOWS §2.3, ADR-UX-07) ----------

// folderVisibility carries the SQL fragments that decide which folders one
// caller may list. Non-admin reads reuse scopeCTE - the exact rule the
// search/stats/export scope uses (READ-01) - so a folder can never be listable
// in one read and hidden in another; admins see every active folder without the
// recursive CTE. The fragments are written against the folder aliases c (the
// page row) and g (a candidate child).
type folderVisibility struct {
	cte          string
	args         []any
	visible      string
	childVisible string
	parentHidden string
}

func (r *Repository) folderVisibilityOf(ctx context.Context, userID string) (folderVisibility, error) {
	admin, err := r.isAdmin(ctx, userID)
	if err != nil {
		return folderVisibility{}, err
	}
	if admin {
		return folderVisibility{
			visible:      "true",
			childVisible: "EXISTS (SELECT 1 FROM folders g WHERE g.parent_id=c.id AND g.deleted_at IS NULL)",
			parentHidden: "c.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM folders p WHERE p.id=c.parent_id AND p.deleted_at IS NULL)",
		}, nil
	}
	return folderVisibility{
		cte:          scopeCTE,
		args:         []any{userID}, // scopeCTE binds the caller to $1
		visible:      "c.id IN (SELECT folder_id FROM visible_scope)",
		childVisible: "EXISTS (SELECT 1 FROM folders g WHERE g.parent_id=c.id AND g.deleted_at IS NULL AND g.id IN (SELECT folder_id FROM visible_scope))",
		// A listable folder whose parent is not in the caller's visible set is an
		// accessible root, so a pruned subtree surfaces without its hidden
		// ancestor (DESKTOP-INTERACTION §5).
		parentHidden: "c.parent_id IS NULL OR c.parent_id NOT IN (SELECT folder_id FROM visible_scope)",
	}, nil
}

// folderPageRows runs one ordered page. Ordering is name then id, and the
// (name,id) keyset cursor uses the same key, so paging is total and stable even
// for duplicate names.
func (r *Repository) folderPageRows(ctx context.Context, scope folderVisibility, where []string, limit int) ([]ports.FolderPageRow, error) {
	sql := scope.cte + " SELECT c.id,c.name,c.parent_id," + scope.childVisible + " AS has_children" +
		" FROM folders c WHERE " + strings.Join(where, " AND ") +
		" ORDER BY c.name ASC,c.id ASC LIMIT " + fmt.Sprint(limit)
	rows, err := r.Q.Query(ctx, sql, scope.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ports.FolderPageRow, 0)
	for rows.Next() {
		var row ports.FolderPageRow
		if err := rows.Scan(&row.Folder.ID, &row.Folder.Name, &row.Folder.ParentID, &row.HasChildren); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// ListVisibleFolderChildren returns one page of the caller's visible children of
// ParentID ("" addresses the visible roots).
func (r *Repository) ListVisibleFolderChildren(ctx context.Context, q ports.FolderChildQuery) ([]ports.FolderPageRow, error) {
	if q.Limit <= 0 || q.Limit > ports.MaxFolderPage+1 {
		return nil, domain.ErrInvalidInput
	}
	scope, err := r.folderVisibilityOf(ctx, q.UserID)
	if err != nil {
		return nil, err
	}
	ph := newPlaceholder(len(scope.args))
	where := []string{"c.deleted_at IS NULL", scope.visible}
	if q.ParentID == "" {
		where = append(where, "("+scope.parentHidden+")")
	} else {
		where = append(where, "c.parent_id="+ph.next())
		scope.args = append(scope.args, q.ParentID)
	}
	if q.CursorID != "" {
		where = append(where, "(c.name,c.id)>("+ph.next()+","+ph.next()+")")
		scope.args = append(scope.args, q.CursorName, q.CursorID)
	}
	return r.folderPageRows(ctx, scope, where, q.Limit)
}

// SearchVisibleFolders returns one page of visible folders whose name matches
// Query. The match is a plain ILIKE fragment, so % and _ behave as wildcards
// exactly like the file search.
func (r *Repository) SearchVisibleFolders(ctx context.Context, q ports.FolderSearchQuery) ([]ports.FolderPageRow, error) {
	if q.Limit <= 0 || q.Limit > ports.MaxFolderPage+1 {
		return nil, domain.ErrInvalidInput
	}
	query := strings.TrimSpace(q.Query)
	if query == "" {
		return nil, domain.ErrInvalidInput
	}
	scope, err := r.folderVisibilityOf(ctx, q.UserID)
	if err != nil {
		return nil, err
	}
	ph := newPlaceholder(len(scope.args))
	where := []string{"c.deleted_at IS NULL", scope.visible, "c.name ILIKE " + ph.next()}
	scope.args = append(scope.args, "%"+query+"%")
	if q.CursorID != "" {
		where = append(where, "(c.name,c.id)>("+ph.next()+","+ph.next()+")")
		scope.args = append(scope.args, q.CursorName, q.CursorID)
	}
	return r.folderPageRows(ctx, scope, where, q.Limit)
}

func (r *Repository) FolderByID(ctx context.Context, id string) (domain.Folder, error) {
	var f domain.Folder
	err := r.Q.QueryRow(ctx, "SELECT id,name,parent_id,owner_id,deleted_at FROM folders WHERE id=$1", id).
		Scan(&f.ID, &f.Name, &f.ParentID, &f.OwnerID, &f.DeletedAt)
	if err != nil {
		return domain.Folder{}, err
	}
	return f, nil
}

func (r *Repository) FolderParentMap(ctx context.Context) (map[string]*string, error) {
	rows, err := r.Q.Query(ctx, "SELECT id,parent_id FROM folders WHERE deleted_at IS NULL")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]*string{}
	for rows.Next() {
		var id string
		var parent *string
		if err := rows.Scan(&id, &parent); err != nil {
			return nil, err
		}
		out[id] = parent
	}
	return out, rows.Err()
}

func (r *Repository) CreateFolder(ctx context.Context, f domain.Folder) error {
	_, err := r.Q.Exec(ctx, "INSERT INTO folders(id,name,parent_id,owner_id) VALUES($1,$2,$3,$4)", f.ID, f.Name, f.ParentID, f.OwnerID)
	if isUniqueViolation(err) {
		return domain.ErrNameConflict
	}
	if isCheckViolation(err) {
		return domain.ErrInvalidInput
	}
	return err
}

func (r *Repository) RenameFolder(ctx context.Context, id, name string) error {
	tag, err := r.Q.Exec(ctx, "UPDATE folders SET name=$2,updated_at=now() WHERE id=$1 AND deleted_at IS NULL", id, name)
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

func (r *Repository) MoveFolder(ctx context.Context, id string, parentID *string) error {
	tag, err := r.Q.Exec(ctx, "UPDATE folders SET parent_id=$2,updated_at=now() WHERE id=$1 AND deleted_at IS NULL", id, parentID)
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

func (r *Repository) SoftDeleteFolder(ctx context.Context, id string) error {
	tag, err := r.Q.Exec(ctx, "UPDATE folders SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL", id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func (r *Repository) SoftDeleteFilesUnderFolders(ctx context.Context, folderIDs []string) error {
	if len(folderIDs) == 0 {
		return nil
	}
	_, err := r.Q.Exec(ctx, "UPDATE files SET deleted_at=now() WHERE folder_id=ANY($1) AND deleted_at IS NULL", folderIDs)
	return err
}

func (r *Repository) RestoreFilesUnderFolders(ctx context.Context, folderIDs []string) error {
	if len(folderIDs) == 0 {
		return nil
	}
	_, err := r.Q.Exec(ctx, "UPDATE files SET deleted_at=NULL,updated_at=now() WHERE folder_id=ANY($1) AND deleted_at IS NOT NULL", folderIDs)
	return err
}

func (r *Repository) CountFilesInFolders(ctx context.Context, folderIDs []string) (int, error) {
	if len(folderIDs) == 0 {
		return 0, nil
	}
	var n int
	err := r.Q.QueryRow(ctx, "SELECT count(*) FROM files WHERE folder_id=ANY($1) AND deleted_at IS NULL", folderIDs).Scan(&n)
	return n, err
}

func (r *Repository) RestoreFolder(ctx context.Context, id string) error {
	tag, err := r.Q.Exec(ctx, "UPDATE folders SET deleted_at=NULL WHERE id=$1 AND deleted_at IS NOT NULL", id)
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

// FolderSubtree returns the folder and all of its active descendants, shallow
// first, so callers can delete and restore in dependency order.
func (r *Repository) FolderSubtree(ctx context.Context, id string) ([]domain.Folder, error) {
	rows, err := r.Q.Query(ctx,
		"WITH RECURSIVE sub(id,name,parent_id,owner_id,deleted_at,depth) AS ("+
			"SELECT id,name,parent_id,owner_id,deleted_at,0 FROM folders WHERE id=$1"+
			" UNION ALL SELECT f.id,f.name,f.parent_id,f.owner_id,f.deleted_at,s.depth+1 FROM sub s JOIN folders f ON f.parent_id=s.id WHERE s.depth<64"+
			") SELECT id,name,parent_id,owner_id,deleted_at FROM sub WHERE deleted_at IS NULL ORDER BY depth,id", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Folder, 0)
	for rows.Next() {
		var f domain.Folder
		if err := rows.Scan(&f.ID, &f.Name, &f.ParentID, &f.OwnerID, &f.DeletedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (r *Repository) RenameFile(ctx context.Context, id, name string) error {
	tag, err := r.Q.Exec(ctx, "UPDATE files SET name=$2,updated_at=now() WHERE id=$1 AND deleted_at IS NULL", id, name)
	if err != nil {
		if isUniqueViolation(err) {
			return domain.ErrNameConflict
		}
		return err
	}
	if tag.RowsAffected() == 0 {
		return ports.ErrRowMissing
	}
	return nil
}

// MoveFile reparents an active file. The partial unique index
// uq_file_active_name(folder_id,name) rejects a live name collision in the
// target, which surfaces as E_NAME_CONFLICT exactly like a rename.
func (r *Repository) MoveFile(ctx context.Context, id, folderID string) error {
	tag, err := r.Q.Exec(ctx, "UPDATE files SET folder_id=$2,updated_at=now() WHERE id=$1 AND deleted_at IS NULL", id, folderID)
	if err != nil {
		if isUniqueViolation(err) {
			return domain.ErrNameConflict
		}
		return err
	}
	if tag.RowsAffected() == 0 {
		return ports.ErrRowMissing
	}
	return nil
}

// FolderSubtreeIncludingDeleted returns the folder and all descendants, deleted
// or not, shallow first, so a trashed subtree can be revived wholesale.
func (r *Repository) FolderSubtreeIncludingDeleted(ctx context.Context, id string) ([]domain.Folder, error) {
	rows, err := r.Q.Query(ctx,
		"WITH RECURSIVE sub(id,name,parent_id,owner_id,deleted_at,depth) AS ("+
			"SELECT id,name,parent_id,owner_id,deleted_at,0 FROM folders WHERE id=$1"+
			" UNION ALL SELECT f.id,f.name,f.parent_id,f.owner_id,f.deleted_at,s.depth+1 FROM sub s JOIN folders f ON f.parent_id=s.id WHERE s.depth<64"+
			") SELECT id,name,parent_id,owner_id,deleted_at FROM sub ORDER BY depth,id", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Folder, 0)
	for rows.Next() {
		var f domain.Folder
		if err := rows.Scan(&f.ID, &f.Name, &f.ParentID, &f.OwnerID, &f.DeletedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (r *Repository) SubtreeFileCount(ctx context.Context, id string) (int, error) {
	var n int
	err := r.Q.QueryRow(ctx,
		"WITH RECURSIVE sub(id) AS ("+
			"SELECT id FROM folders WHERE id=$1 AND deleted_at IS NULL"+
			" UNION ALL SELECT f.id FROM sub s JOIN folders f ON f.parent_id=s.id WHERE f.deleted_at IS NULL"+
			") SELECT count(*) FROM files WHERE folder_id=ANY(SELECT id FROM sub) AND deleted_at IS NULL", id).Scan(&n)
	return n, err
}

// ---------- files ----------

const fileSelect = "SELECT f.id,f.folder_id,f.name,f.uploaded_by,f.content_type,f.current_version_seq,v.size_bytes,v.sha256,f.updated_at,f.deleted_at FROM files f LEFT JOIN file_versions v ON v.file_id=f.id AND v.seq=f.current_version_seq"

func scanFile(row rowScanner) (domain.File, error) {
	var f domain.File
	err := row.Scan(&f.ID, &f.FolderID, &f.Name, &f.UploadedBy, &f.ContentType, &f.CurrentVersionSeq, &f.SizeBytes, &f.Sha256, &f.UpdatedAt, &f.DeletedAt)
	return f, err
}

func (r *Repository) ListFiles(ctx context.Context, q ports.FileQuery) ([]domain.File, error) {
	// The service sends page size + 1 lookahead row, so the ceiling is
	// MaxFilePage+1; a plain MaxFilePage request must not fail here.
	if q.Limit <= 0 || q.Limit > ports.MaxFilePage+1 {
		return nil, domain.ErrInvalidInput
	}
	order := "f.updated_at DESC,f.id DESC"
	switch q.Sort {
	case "", "updated_desc":
		order = "f.updated_at DESC,f.id DESC"
	case "updated_asc":
		order = "f.updated_at ASC,f.id ASC"
	case "name_asc":
		order = "f.name ASC,f.id ASC"
	case "name_desc":
		order = "f.name DESC,f.id DESC"
	case "size_desc":
		order = "v.size_bytes DESC NULLS LAST,f.id DESC"
	default:
		return nil, domain.ErrInvalidInput
	}
	// The first page carries no cursor; an empty cursor must not filter anything.
	cursor, args := "", []any{q.FolderID}
	if q.CursorID != "" {
		placeholder := "($2,$3)"
		switch q.Sort {
		case "updated_asc":
			cursor = " AND (f.updated_at,f.id) > " + placeholder
			args = append(args, q.CursorTime, q.CursorID)
		case "name_asc":
			cursor = " AND (f.name,f.id) > " + placeholder
			args = append(args, q.CursorName, q.CursorID)
		case "name_desc":
			cursor = " AND (f.name,f.id) < " + placeholder
			args = append(args, q.CursorName, q.CursorID)
		case "size_desc":
			cursor = " AND (coalesce(v.size_bytes,-1),f.id) < " + placeholder
			args = append(args, q.CursorSize, q.CursorID)
		default:
			cursor = " AND (f.updated_at,f.id) < " + placeholder
			args = append(args, q.CursorTime, q.CursorID)
		}
	}
	sql := fileSelect + " WHERE f.folder_id=$1 AND f.deleted_at IS NULL" + cursor + " ORDER BY " + order + " LIMIT " + fmt.Sprint(q.Limit)
	rows, err := r.Q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.File, 0)
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (r *Repository) FileByID(ctx context.Context, id string) (domain.File, error) {
	row := r.Q.QueryRow(ctx, fileSelect+" WHERE f.id=$1", id)
	f, err := scanFile(row)
	if err != nil {
		return domain.File{}, err
	}
	return f, nil
}

func (r *Repository) FileByNameInFolder(ctx context.Context, folderID, name string) (domain.File, error) {
	row := r.Q.QueryRow(ctx, fileSelect+" WHERE f.folder_id=$1 AND f.name=$2 AND f.deleted_at IS NULL", folderID, name)
	f, err := scanFile(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.File{}, ports.ErrRowMissing
		}
		return domain.File{}, err
	}
	return f, nil
}

func (r *Repository) CreateFileWithFirstVersion(ctx context.Context, f domain.File, v domain.FileVersion) error {
	if _, err := r.Q.Exec(ctx,
		"INSERT INTO files(id,folder_id,name,uploaded_by,content_type,current_version_seq) VALUES($1,$2,$3,$4,$5,$6)",
		f.ID, f.FolderID, f.Name, f.UploadedBy, f.ContentType, f.CurrentVersionSeq); err != nil {
		if isUniqueViolation(err) {
			return domain.ErrNameConflict
		}
		return err
	}
	return insertVersion(ctx, r, v)
}

func (r *Repository) InsertBlob(ctx context.Context, b domain.Blob) error {
	_, err := r.Q.Exec(ctx,
		"INSERT INTO blobs(id,storage_key,sha256,size_bytes,state) VALUES($1,$2,$3,$4,$5)",
		b.ID, b.StorageKey, b.Sha256, b.SizeBytes, b.State)
	if isUniqueViolation(err) {
		return domain.ErrConflict
	}
	return err
}

func (r *Repository) HasActiveApprovalPolicy(ctx context.Context, folderID string) (bool, error) {
	var blocked bool
	err := r.Q.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM approval_policies WHERE folder_id=$1 AND enabled)", folderID).Scan(&blocked)
	return blocked, err
}

func (r *Repository) UserExists(ctx context.Context, id string) (bool, error) {
	var found bool
	err := r.Q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND disabled_at IS NULL)", id).Scan(&found)
	return found, err
}

func (r *Repository) WorkgroupExists(ctx context.Context, id string) (bool, error) {
	var found bool
	err := r.Q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM workgroups WHERE id=$1)", id).Scan(&found)
	return found, err
}

func insertVersion(ctx context.Context, r *Repository, v domain.FileVersion) error {
	_, err := r.Q.Exec(ctx,
		"INSERT INTO file_versions(id,file_id,seq,blob_id,size_bytes,sha256,action,base_seq,rollback_target_seq,rollback_from_seq,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
		v.ID, v.FileID, v.Seq, v.BlobID, v.SizeBytes, v.Sha256, v.Action, v.BaseSeq, v.RollbackTargetSeq, v.RollbackFromSeq, v.Reason, v.CreatedBy)
	if isUniqueViolation(err) {
		return domain.ErrVersionConflict
	}
	return err
}

func (r *Repository) AppendVersion(ctx context.Context, v domain.FileVersion) error {
	return insertVersion(ctx, r, v)
}

func (r *Repository) UpdateCurrentVersion(ctx context.Context, fileID string, seq int) error {
	tag, err := r.Q.Exec(ctx, "UPDATE files SET current_version_seq=$2,updated_at=now() WHERE id=$1", fileID, seq)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func (r *Repository) SetFileContentType(ctx context.Context, fileID, contentType string) error {
	_, err := r.Q.Exec(ctx, "UPDATE files SET content_type=$2 WHERE id=$1", fileID, contentType)
	return err
}

func (r *Repository) SoftDeleteFile(ctx context.Context, id string) error {
	tag, err := r.Q.Exec(ctx, "UPDATE files SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL", id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func (r *Repository) RestoreFile(ctx context.Context, id string) error {
	tag, err := r.Q.Exec(ctx, "UPDATE files SET deleted_at=NULL,updated_at=now() WHERE id=$1 AND deleted_at IS NOT NULL", id)
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

func (r *Repository) NextVersionSeq(ctx context.Context, fileID string) (int, error) {
	var next int
	err := r.Q.QueryRow(ctx, "SELECT coalesce(max(seq),0)+1 FROM file_versions WHERE file_id=$1", fileID).Scan(&next)
	return next, err
}

const versionSelect = "SELECT v.id,v.file_id,v.seq,v.blob_id,v.size_bytes,v.sha256,v.action,v.base_seq,v.rollback_target_seq,v.rollback_from_seq,coalesce(v.reason,''),v.created_by,coalesce(u.display_name,''),v.created_at FROM file_versions v LEFT JOIN users u ON u.id=v.created_by"

func scanVersion(row rowScanner) (domain.FileVersion, error) {
	var v domain.FileVersion
	err := row.Scan(&v.ID, &v.FileID, &v.Seq, &v.BlobID, &v.SizeBytes, &v.Sha256, &v.Action, &v.BaseSeq, &v.RollbackTargetSeq, &v.RollbackFromSeq, &v.Reason, &v.CreatedBy, &v.CreatedByName, &v.CreatedAt)
	return v, err
}

func (r *Repository) VersionsByFile(ctx context.Context, fileID string) ([]domain.FileVersion, error) {
	rows, err := r.Q.Query(ctx, versionSelect+" WHERE v.file_id=$1 ORDER BY v.seq", fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.FileVersion, 0)
	for rows.Next() {
		v, err := scanVersion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (r *Repository) VersionBySeq(ctx context.Context, fileID string, seq int) (domain.FileVersion, error) {
	row := r.Q.QueryRow(ctx, versionSelect+" WHERE v.file_id=$1 AND v.seq=$2", fileID, seq)
	v, err := scanVersion(row)
	if err != nil {
		return domain.FileVersion{}, err
	}
	return v, nil
}

func (r *Repository) BlobBySha(ctx context.Context, sha string) (domain.Blob, error) {
	var b domain.Blob
	err := r.Q.QueryRow(ctx, "SELECT id,storage_key,sha256,size_bytes,state FROM blobs WHERE sha256=$1 AND state='ready'", sha).
		Scan(&b.ID, &b.StorageKey, &b.Sha256, &b.SizeBytes, &b.State)
	if err != nil {
		return domain.Blob{}, err
	}
	return b, nil
}

func (r *Repository) BlobByID(ctx context.Context, id string) (domain.Blob, error) {
	var b domain.Blob
	err := r.Q.QueryRow(ctx, "SELECT id,storage_key,sha256,size_bytes,state FROM blobs WHERE id=$1", id).
		Scan(&b.ID, &b.StorageKey, &b.Sha256, &b.SizeBytes, &b.State)
	if err != nil {
		return domain.Blob{}, err
	}
	return b, nil
}

func (r *Repository) SetBlobState(ctx context.Context, id, state string) error {
	_, err := r.Q.Exec(ctx, "UPDATE blobs SET state=$2 WHERE id=$1", id, state)
	return err
}

// ---------- grants ----------

func (r *Repository) WorkgroupsOf(ctx context.Context, userID string) ([]string, error) {
	rows, err := r.Q.Query(ctx, "SELECT group_id FROM workgroup_members WHERE user_id=$1", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// EffectiveGrants returns every live grant the user or their groups hold on any
// folder in the ancestor chain of folderID (inclusive), with depth annotations.
func (r *Repository) EffectiveGrants(ctx context.Context, userID, folderID string) ([]ports.GrantAt, error) {
	rows, err := r.Q.Query(ctx,
		"WITH RECURSIVE chain(folder_id,depth) AS ("+
			"SELECT $2,0"+
			" UNION ALL SELECT f.parent_id,c.depth+1 FROM chain c JOIN folders f ON f.id=c.folder_id"+
			" WHERE f.parent_id IS NOT NULL AND c.depth<64"+
			") SELECT g.id,g.folder_id,g.subject_kind,g.subject_id,g.actions,g.scope_only,g.expires_at,g.granted_by,coalesce(u.display_name,''),c.depth"+
			" FROM chain c JOIN acls g ON g.folder_id=c.folder_id LEFT JOIN users u ON u.id=g.granted_by"+
			" WHERE (g.expires_at IS NULL OR g.expires_at>now())"+
			" AND ((g.subject_kind='user' AND g.subject_id=$1)"+
			" OR (g.subject_kind='group' AND g.subject_id IN (SELECT group_id FROM workgroup_members WHERE user_id=$1)))", userID, folderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ports.GrantAt, 0)
	for rows.Next() {
		var g ports.GrantAt
		var actions []string
		err := rows.Scan(&g.Grant.ID, &g.Grant.FolderID, &g.Grant.SubjectKind, &g.Grant.SubjectID, &actions, &g.Grant.ScopeOnly, &g.Grant.ExpiresAt, &g.Grant.GrantedBy, &g.Grant.GrantedByName, &g.Depth)
		if err != nil {
			return nil, err
		}
		g.Grant.Actions = toActions(actions)
		out = append(out, g)
	}
	return out, rows.Err()
}

func toActions(values []string) []domain.Action {
	out := make([]domain.Action, 0, len(values))
	for _, v := range values {
		out = append(out, domain.Action(v))
	}
	return out
}

func actionsToStrings(actions []domain.Action) []string {
	out := make([]string, 0, len(actions))
	for _, a := range actions {
		out = append(out, string(a))
	}
	return out
}

func (r *Repository) ListGrants(ctx context.Context, folderID string) ([]domain.ACL, error) {
	rows, err := r.Q.Query(ctx,
		"SELECT g.id,g.folder_id,g.subject_kind,g.subject_id,g.actions,g.scope_only,g.expires_at,g.granted_by,coalesce(u.display_name,'') "+
			"FROM acls g LEFT JOIN users u ON u.id=g.granted_by WHERE g.folder_id=$1 ORDER BY g.id", folderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.ACL, 0)
	for rows.Next() {
		var g domain.ACL
		var actions []string
		if err := rows.Scan(&g.ID, &g.FolderID, &g.SubjectKind, &g.SubjectID, &actions, &g.ScopeOnly, &g.ExpiresAt, &g.GrantedBy, &g.GrantedByName); err != nil {
			return nil, err
		}
		g.Actions = toActions(actions)
		out = append(out, g)
	}
	return out, rows.Err()
}

func (r *Repository) GrantByID(ctx context.Context, id string) (domain.ACL, error) {
	var g domain.ACL
	var actions []string
	err := r.Q.QueryRow(ctx,
		"SELECT g.id,g.folder_id,g.subject_kind,g.subject_id,g.actions,g.scope_only,g.expires_at,g.granted_by,coalesce(u.display_name,'') "+
			"FROM acls g LEFT JOIN users u ON u.id=g.granted_by WHERE g.id=$1", id).
		Scan(&g.ID, &g.FolderID, &g.SubjectKind, &g.SubjectID, &actions, &g.ScopeOnly, &g.ExpiresAt, &g.GrantedBy, &g.GrantedByName)
	if err != nil {
		return domain.ACL{}, err
	}
	g.Actions = toActions(actions)
	return g, nil
}

func (r *Repository) InsertGrant(ctx context.Context, g domain.ACL) error {
	if len(g.Actions) == 0 {
		return domain.ErrInvalidInput
	}
	for _, a := range g.Actions {
		if !domain.AllowedAction(a) {
			return domain.ErrInvalidInput
		}
	}
	if g.SubjectKind != "user" && g.SubjectKind != "group" {
		return domain.ErrInvalidInput
	}
	_, err := r.Q.Exec(ctx,
		"INSERT INTO acls(id,folder_id,subject_kind,subject_id,actions,scope_only,expires_at,granted_by) VALUES($1,$2,$3,$4,$5::text[],$6,$7,$8)",
		g.ID, g.FolderID, g.SubjectKind, g.SubjectID, actionsToStrings(g.Actions), g.ScopeOnly, g.ExpiresAt, g.GrantedBy)
	return err
}

func (r *Repository) DeleteGrant(ctx context.Context, id string) error {
	tag, err := r.Q.Exec(ctx, "DELETE FROM acls WHERE id=$1", id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

// ---------- trash ----------

func (r *Repository) InsertTrashEntry(ctx context.Context, t domain.TrashEntry) error {
	var snapshot any
	if len(t.OldParentTrail) > 0 {
		encoded, err := json.Marshal(t.OldParentTrail)
		if err != nil {
			return err
		}
		snapshot = string(encoded)
	}
	_, err := r.Q.Exec(ctx,
		"INSERT INTO trash_entries(id,file_id,folder_id,old_parent_id,old_name,deleted_by,old_parent_trail) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
		t.ID, t.FileID, t.FolderID, t.OldParentID, t.OldName, t.DeletedBy, snapshot)
	return err
}

// ListTrashEntries returns entries the user deleted plus entries the user is
// allowed to restore (holds upload on the original parent chain).
func (r *Repository) ListTrashEntries(ctx context.Context, userID string) ([]domain.TrashEntry, error) {
	rows, err := r.Q.Query(ctx,
		"WITH RECURSIVE chains(entry_id,folder_id) AS ("+
			"SELECT id,old_parent_id FROM trash_entries WHERE old_parent_id IS NOT NULL"+
			" UNION ALL SELECT c.entry_id,f.parent_id FROM chains c JOIN folders f ON f.id=c.folder_id WHERE f.parent_id IS NOT NULL"+
			"), permitted AS ("+
			"SELECT DISTINCT c.entry_id FROM chains c JOIN acls g ON g.folder_id=c.folder_id"+
			" WHERE (g.expires_at IS NULL OR g.expires_at>now()) AND 'upload'=ANY(g.actions)"+
			" AND ((g.subject_kind='user' AND g.subject_id=$1)"+
			" OR (g.subject_kind='group' AND g.subject_id IN (SELECT group_id FROM workgroup_members WHERE user_id=$1)))"+
			") SELECT t.id,t.file_id,t.folder_id,t.old_parent_id,t.old_name,t.deleted_by,coalesce(u.display_name,''),t.deleted_at,t.restored_at,t.purged_at,t.old_parent_trail"+
			" FROM trash_entries t LEFT JOIN users u ON u.id=t.deleted_by"+
			" WHERE t.restored_at IS NULL AND t.purged_at IS NULL AND (t.deleted_by=$1 OR t.id IN (SELECT entry_id FROM permitted))"+
			" ORDER BY t.deleted_at DESC LIMIT 500", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.TrashEntry, 0)
	for rows.Next() {
		var t domain.TrashEntry
		var snapshot []byte
		if err := rows.Scan(&t.ID, &t.FileID, &t.FolderID, &t.OldParentID, &t.OldName, &t.DeletedBy, &t.DeletedName, &t.DeletedAt, &t.RestoredAt, &t.PurgedAt, &snapshot); err != nil {
			return nil, err
		}
		if len(snapshot) > 0 {
			if err := json.Unmarshal(snapshot, &t.OldParentTrail); err != nil {
				return nil, err
			}
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (r *Repository) TrashEntryByID(ctx context.Context, id string) (domain.TrashEntry, error) {
	var t domain.TrashEntry
	var snapshot []byte
	err := r.Q.QueryRow(ctx,
		"SELECT t.id,t.file_id,t.folder_id,t.old_parent_id,t.old_name,t.deleted_by,coalesce(u.display_name,''),t.deleted_at,t.restored_at,t.purged_at,t.old_parent_trail "+
			"FROM trash_entries t LEFT JOIN users u ON u.id=t.deleted_by WHERE t.id=$1", id).
		Scan(&t.ID, &t.FileID, &t.FolderID, &t.OldParentID, &t.OldName, &t.DeletedBy, &t.DeletedName, &t.DeletedAt, &t.RestoredAt, &t.PurgedAt, &snapshot)
	if err != nil {
		return domain.TrashEntry{}, err
	}
	if len(snapshot) > 0 {
		if err = json.Unmarshal(snapshot, &t.OldParentTrail); err != nil {
			return domain.TrashEntry{}, err
		}
	}
	return t, nil
}

func (r *Repository) MarkTrashRestored(ctx context.Context, id string) error {
	tag, err := r.Q.Exec(ctx, "UPDATE trash_entries SET restored_at=now() WHERE id=$1 AND restored_at IS NULL AND purged_at IS NULL", id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func (r *Repository) MarkTrashPurged(ctx context.Context, id string) error {
	tag, err := r.Q.Exec(ctx, "UPDATE trash_entries SET purged_at=now() WHERE id=$1 AND purged_at IS NULL", id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

// ---------- audit and idempotency ----------

func (r *Repository) RecordAudit(ctx context.Context, e domain.AuditEvent) error {
	details := e.Details
	if details == nil {
		details = map[string]any{}
	}
	_, err := r.Q.Exec(ctx,
		"INSERT INTO audit_events(actor_id,event_type,target_kind,target_id,request_id,outcome,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
		e.ActorID, e.EventType, e.TargetKind, e.TargetID, e.RequestID, e.Outcome, marshalDetails(details))
	return err
}

// Descending keyset audit read, restricted to access-changing event types.
func (r *Repository) ListPermissionAudit(ctx context.Context, beforeID int64, limit int) ([]domain.PermissionAuditRecord, error) {
	if limit < 1 || limit > 101 || beforeID < 0 {
		return nil, domain.ErrInvalidInput
	}
	rows, err := r.Q.Query(ctx, `SELECT id,coalesce(actor_id,''),request_id,event_type,target_kind,target_id,outcome,
	  details,created_at FROM audit_events
	  WHERE ($1::bigint=0 OR id<$1)
	  AND event_type IN ('acl.create','acl.revoke','workgroup.member_add','workgroup.member_remove','workgroup.delete',
	    'user.create','user.disable','user.enable','user.password_reset','share.create','share.revoke',
	    'role.assign','role.revoke')
	  ORDER BY id DESC LIMIT $2`, beforeID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.PermissionAuditRecord, 0, limit)
	for rows.Next() {
		var item domain.PermissionAuditRecord
		var details []byte
		if err = rows.Scan(&item.ID, &item.ActorID, &item.RequestID, &item.EventType, &item.TargetKind,
			&item.TargetID, &item.Outcome, &details, &item.CreatedAt); err != nil {
			return nil, err
		}
		item.Details = map[string]any{}
		if err = json.Unmarshal(details, &item.Details); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *Repository) IdempotencyGet(ctx context.Context, actor, operation, key string) ([]byte, bool, error) {
	var response []byte
	err := r.Q.QueryRow(ctx, "SELECT response::text FROM idempotency_keys WHERE actor_id=$1 AND operation=$2 AND request_key=$3", actor, operation, key).Scan(&response)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, nil
		}
		return nil, false, err
	}
	if response == nil {
		return []byte("null"), true, nil
	}
	return response, true, nil
}

func (r *Repository) IdempotencyPut(ctx context.Context, actor, operation, key string, response []byte) error {
	_, err := r.Q.Exec(ctx,
		"INSERT INTO idempotency_keys(actor_id,operation,request_key,response) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING",
		actor, operation, key, string(response))
	return err
}
