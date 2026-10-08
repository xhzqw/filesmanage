package postgres

import (
	"context"
	"errors"
	"fmt"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
)

// ---------- shares ----------

const shareSelect = "SELECT s.id,s.file_id,s.folder_id,s.recipient_kind,s.recipient_id,s.actions,s.include_descendants,s.expires_at,s.revoked_at,s.created_by,s.created_at,coalesce(f.name,''),coalesce(d.name,''),coalesce(rn.display_name,'') FROM shares s LEFT JOIN files f ON f.id=s.file_id LEFT JOIN folders d ON d.id=s.folder_id LEFT JOIN users rn ON rn.id=s.recipient_id"

func scanShare(row rowScanner) (domain.Share, error) {
	var s domain.Share
	var actions []string
	err := row.Scan(&s.ID, &s.FileID, &s.FolderID, &s.RecipientKind, &s.RecipientID, &actions,
		&s.IncludeDescendants, &s.ExpiresAt, &s.RevokedAt, &s.CreatedBy, &s.CreatedAt,
		&s.ResourceName, &s.ResourceName, &s.RecipientName)
	if err != nil {
		return domain.Share{}, err
	}
	s.Actions = toActions(actions)
	return s, nil
}

func (r *Repository) ListSharesForSubject(ctx context.Context, userID string, groupIDs []string) ([]domain.Share, error) {
	rows, err := r.Q.Query(ctx,
		shareSelect+` WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>now())
		 AND ((s.recipient_kind='user' AND s.recipient_id=$1)
		   OR (s.recipient_kind='group' AND s.recipient_id=ANY($2::text[])))
		 ORDER BY s.created_at DESC LIMIT 200`, userID, groupIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Share, 0)
	for rows.Next() {
		s, err := scanShare(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (r *Repository) ListSharesCreatedBy(ctx context.Context, userID string) ([]domain.Share, error) {
	rows, err := r.Q.Query(ctx, shareSelect+" WHERE s.created_by=$1 ORDER BY s.created_at DESC LIMIT 200", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Share, 0)
	for rows.Next() {
		s, err := scanShare(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (r *Repository) ShareByID(ctx context.Context, id string) (domain.Share, error) {
	row := r.Q.QueryRow(ctx, shareSelect+" WHERE s.id=$1", id)
	s, err := scanShare(row)
	if err != nil {
		return domain.Share{}, err
	}
	return s, nil
}

func (r *Repository) CreateShare(ctx context.Context, s domain.Share) error {
	if len(s.Actions) == 0 {
		return domain.ErrInvalidInput
	}
	for _, a := range s.Actions {
		// Shares may only grant the passive subset (SPEC §2.4).
		if a != domain.ActionList && a != domain.ActionPreview && a != domain.ActionDownload {
			return domain.ErrInvalidInput
		}
	}
	if (s.FileID == nil) == (s.FolderID == nil) {
		return domain.ErrInvalidInput
	}
	if s.RecipientKind != "user" && s.RecipientKind != "group" {
		return domain.ErrInvalidInput
	}
	_, err := r.Q.Exec(ctx,
		`INSERT INTO shares(id,file_id,folder_id,recipient_kind,recipient_id,actions,include_descendants,expires_at,created_by)
		 VALUES($1,$2,$3,$4,$5,$6::text[],$7,$8,$9)`,
		s.ID, s.FileID, s.FolderID, s.RecipientKind, s.RecipientID, actionsToStrings(s.Actions), s.IncludeDescendants, s.ExpiresAt, s.CreatedBy)
	if isForeignKeyViolation(err) {
		return domain.ErrInvalidInput
	}
	return err
}

func (r *Repository) RevokeShare(ctx context.Context, id string) error {
	_, err := r.Q.Exec(ctx, "UPDATE shares SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL", id)
	return err
}

// ---------- favorites ----------

const favoriteSelect = "SELECT fa.id,fa.user_id,fa.file_id,fa.folder_id,fa.created_at,coalesce(f.name,''),coalesce(d.name,''),(f.deleted_at IS NOT NULL OR d.deleted_at IS NOT NULL) FROM favorites fa LEFT JOIN files f ON f.id=fa.file_id LEFT JOIN folders d ON d.id=fa.folder_id"

func scanFavorite(row rowScanner) (domain.Favorite, error) {
	var f domain.Favorite
	var fileName, folderName *string
	err := row.Scan(&f.ID, &f.UserID, &f.FileID, &f.FolderID, &f.CreatedAt, &fileName, &folderName, &f.Unavailable)
	if err != nil {
		return domain.Favorite{}, err
	}
	if fileName != nil {
		f.ResourceName = *fileName
	} else if folderName != nil {
		f.ResourceName = *folderName
	}
	return f, nil
}

func (r *Repository) ListFavorites(ctx context.Context, userID string) ([]domain.Favorite, error) {
	rows, err := r.Q.Query(ctx, favoriteSelect+" WHERE fa.user_id=$1 ORDER BY fa.created_at DESC LIMIT 500", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Favorite, 0)
	for rows.Next() {
		f, err := scanFavorite(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (r *Repository) FavoriteExists(ctx context.Context, userID, fileID, folderID string) (bool, error) {
	var exists bool
	if fileID != "" {
		err := r.Q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM favorites WHERE user_id=$1 AND file_id=$2)", userID, fileID).Scan(&exists)
		return exists, err
	}
	err := r.Q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM favorites WHERE user_id=$1 AND folder_id=$2)", userID, folderID).Scan(&exists)
	return exists, err
}

func (r *Repository) AddFavorite(ctx context.Context, f domain.Favorite) error {
	if (f.FileID == nil) == (f.FolderID == nil) {
		return domain.ErrInvalidInput
	}
	_, err := r.Q.Exec(ctx,
		`INSERT INTO favorites(id,user_id,file_id,folder_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
		f.ID, f.UserID, f.FileID, f.FolderID)
	return err
}

func (r *Repository) RemoveFavorite(ctx context.Context, userID, fileID, folderID string) error {
	if fileID != "" {
		_, err := r.Q.Exec(ctx, "DELETE FROM favorites WHERE user_id=$1 AND file_id=$2", userID, fileID)
		return err
	}
	_, err := r.Q.Exec(ctx, "DELETE FROM favorites WHERE user_id=$1 AND folder_id=$2", userID, folderID)
	return err
}

// ---------- search, stats and export share one visibility scope (READ-01) ----------

// scopeCTE resolves every folder the caller may list: ACL grants with ancestor
// inheritance plus folder shares granted to the caller or their workgroups.
const scopeCTE = `
WITH RECURSIVE ancestry AS (
  SELECT f.id child, f.id ancestor, f.parent_id, 0 depth FROM folders f WHERE f.deleted_at IS NULL
  UNION ALL SELECT a.child, p.id, p.parent_id, a.depth+1 FROM ancestry a
    JOIN folders p ON p.id=a.parent_id WHERE a.depth<64 AND p.deleted_at IS NULL
), granted AS (
  SELECT DISTINCT a.child AS folder_id FROM ancestry a JOIN acls g ON g.folder_id=a.ancestor
  WHERE (NOT g.scope_only OR a.depth=0) AND (g.expires_at IS NULL OR g.expires_at>now())
    AND 'list'=ANY(g.actions)
    AND ((g.subject_kind='user' AND g.subject_id=$1)
      OR (g.subject_kind='group' AND g.subject_id IN (SELECT group_id FROM workgroup_members WHERE user_id=$1)))
), shared AS (
  SELECT s.folder_id FROM shares s
  WHERE s.folder_id IS NOT NULL AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>now())
    AND ((s.recipient_kind='user' AND s.recipient_id=$1)
      OR (s.recipient_kind='group' AND s.recipient_id IN (SELECT group_id FROM workgroup_members WHERE user_id=$1)))
), visible_scope AS (
  SELECT folder_id FROM granted UNION SELECT folder_id FROM shared
)`

// isAdmin reports whether the caller bypasses the scope CTE.
func (r *Repository) isAdmin(ctx context.Context, userID string) (bool, error) {
	var admin bool
	err := r.Q.QueryRow(ctx, "SELECT is_admin FROM users WHERE id=$1", userID).Scan(&admin)
	return admin, err
}

// scopeFolderSQL builds the folder restriction plus its placeholders, and
// reports whether the shared scope CTE is required.
func (r *Repository) scopeFolderSQL(ctx context.Context, q ports.FileSearchQuery) (string, []any, bool, error) {
	if q.FolderID != "" {
		if q.IncludeDescendant {
			return "f.folder_id IN (WITH RECURSIVE sub(id) AS (SELECT $2::text UNION ALL SELECT c.id FROM sub s JOIN folders c ON c.parent_id=s.id WHERE c.deleted_at IS NULL) SELECT id FROM sub)",
				[]any{q.FolderID}, false, nil
		}
		return "f.folder_id=$2", []any{q.FolderID}, false, nil
	}
	admin, err := r.isAdmin(ctx, q.UserID)
	if err != nil {
		return "", nil, false, err
	}
	// Admins see every folder; the CTE is still emitted so the SQL text always
	// resolves, and the admin predicate short-circuits its restrictions.
	if admin {
		return "f.folder_id IN (SELECT id FROM folders WHERE deleted_at IS NULL)", nil, false, nil
	}
	return "f.folder_id IN (SELECT folder_id FROM visible_scope)", nil, true, nil
}

// placeholder assigns sequential parameters after the fixed prefix.
type placeholder struct{ n int }

func newPlaceholder(prefixCount int) *placeholder { return &placeholder{n: prefixCount} }
func (p *placeholder) next() string {
	p.n++
	return fmt.Sprintf("$%d", p.n)
}

func (r *Repository) SearchFiles(ctx context.Context, q ports.FileSearchQuery) ([]domain.File, int, error) {
	if q.Limit <= 0 || q.Limit > 200 {
		return nil, 0, domain.ErrInvalidInput
	}
	folderSQL, folderArgs, needsCTE, err := r.scopeFolderSQL(ctx, q)
	if err != nil {
		return nil, 0, err
	}
	// Placeholders must match the emitted SQL: the scope CTE binds $1 to the
	// caller, the folder filter adds $2, and the admin all-folders branch binds
	// nothing at all.
	args := []any{}
	if needsCTE {
		args = append(args, q.UserID)
	}
	args = append(args, folderArgs...)
	where := []string{"f.deleted_at IS NULL", folderSQL}
	ph := newPlaceholder(len(args))
	if q.Query != "" {
		where = append(where, "(ft.spaced ILIKE "+ph.next()+" OR f.name ILIKE "+ph.next()+")")
		args = append(args, "%"+q.Query+"%", "%"+q.Query+"%")
	}
	if q.Uploader != "" {
		where = append(where, "f.uploaded_by="+ph.next())
		args = append(args, q.Uploader)
	}
	if q.MimePrefix != "" {
		where = append(where, "f.content_type LIKE "+ph.next())
		args = append(args, q.MimePrefix+"%")
	}
	if q.From != nil {
		where = append(where, "f.updated_at>="+ph.next())
		args = append(args, *q.From)
	}
	if q.To != nil {
		where = append(where, "f.updated_at<="+ph.next())
		args = append(args, *q.To)
	}
	order := "f.updated_at DESC,f.id DESC"
	switch q.Sort {
	case "", "updated_desc":
	case "name_asc":
		order = "f.name ASC,f.id ASC"
	case "size_desc":
		order = "v.size_bytes DESC NULLS LAST,f.id DESC"
	default:
		return nil, 0, domain.ErrInvalidInput
	}
	if q.CursorID != "" {
		if q.Sort == "name_asc" {
			where = append(where, "(f.name,f.id)>("+ph.next()+","+ph.next()+")")
			args = append(args, q.CursorName, q.CursorID)
		} else {
			where = append(where, "(f.updated_at,f.id)<("+ph.next()+","+ph.next()+")")
			args = append(args, q.CursorTime, q.CursorID)
		}
	}
	cte := ""
	if needsCTE {
		cte = scopeCTE
	}
	sql := cte + " SELECT f.id,f.folder_id,f.name,f.uploaded_by,f.content_type,f.current_version_seq,v.size_bytes,v.sha256,f.updated_at,f.deleted_at" +
		" FROM files f LEFT JOIN file_versions v ON v.file_id=f.id AND v.seq=f.current_version_seq" +
		" LEFT JOIN file_text ft ON ft.file_id=f.id" +
		" WHERE " + strings.Join(where, " AND ") + " ORDER BY " + order + " LIMIT " + fmt.Sprint(q.Limit)
	rows, err := r.Q.Query(ctx, sql, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := make([]domain.File, 0)
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, f)
	}
	return out, len(out), rows.Err()
}

// statsScope builds the shared predicate for aggregation queries.
func (r *Repository) statsScope(q ports.StatsQuery) (cte string, predicate string, args []any, err error) {
	folderSQL, folderArgs, needsCTE, scopeErr := r.scopeFolderSQL(backgroundCtx(), ports.FileSearchQuery{UserID: q.UserID, FolderID: q.FolderID, IncludeDescendant: q.IncludeDescendant})
	if scopeErr != nil {
		return "", "", nil, scopeErr
	}
	// Same placeholder rule as SearchFiles: the scope CTE binds $1 to the caller.
	args = []any{}
	if needsCTE {
		args = append(args, q.UserID)
	}
	args = append(args, folderArgs...)
	where := []string{"f.deleted_at IS NULL", folderSQL}
	ph := newPlaceholder(len(args))
	if q.Uploader != "" {
		where = append(where, "f.uploaded_by="+ph.next())
		args = append(args, q.Uploader)
	}
	if q.MimePrefix != "" {
		where = append(where, "f.content_type LIKE "+ph.next())
		args = append(args, q.MimePrefix+"%")
	}
	if q.From != nil {
		where = append(where, "f.updated_at>="+ph.next())
		args = append(args, *q.From)
	}
	if q.To != nil {
		where = append(where, "f.updated_at<="+ph.next())
		args = append(args, *q.To)
	}
	if needsCTE {
		cte = scopeCTE
	}
	return cte, strings.Join(where, " AND "), args, nil
}

func (r *Repository) Stats(ctx context.Context, q ports.StatsQuery) (domain.Stats, error) {
	cte, predicate, args, err := r.statsScope(q)
	if err != nil {
		return domain.Stats{}, err
	}
	// Admins count every folder; non-admins resolve through the scope CTE, which
	// is emitted only when the caller has no folder filter.
	admin, adminErr := r.isAdmin(ctx, q.UserID)
	if adminErr != nil {
		return domain.Stats{}, adminErr
	}
	folderScope := "d.id IN (SELECT folder_id FROM visible_scope)"
	if admin && q.FolderID == "" {
		folderScope = "d.id IN (SELECT id FROM folders WHERE deleted_at IS NULL)"
	}
	if q.FolderID != "" {
		if q.IncludeDescendant {
			folderScope = "d.id IN (WITH RECURSIVE sub(id) AS (SELECT $2::text UNION ALL SELECT c.id FROM sub s JOIN folders c ON c.parent_id=s.id WHERE c.deleted_at IS NULL) SELECT id FROM sub)"
		} else {
			folderScope = "d.id=$2"
		}
	}
	summary := fmt.Sprintf(
		" SELECT (SELECT count(*) FROM files f WHERE %s),"+
			" (SELECT coalesce(sum(v.size_bytes),0) FROM files f LEFT JOIN file_versions v ON v.file_id=f.id AND v.seq=f.current_version_seq WHERE %s),"+
			" (SELECT count(*) FROM files f WHERE %s AND f.updated_at>now()-interval '30 days'),"+
			" (SELECT count(*) FROM folders d WHERE d.deleted_at IS NULL AND %s)",
		predicate, predicate, predicate, folderScope)
	var stats domain.Stats
	if err = r.Q.QueryRow(ctx, cte+summary, args...).Scan(&stats.TotalFiles, &stats.TotalBytes, &stats.Added30Days, &stats.TotalFolders); err != nil {
		return domain.Stats{}, err
	}
	typeScan := func(s rowScanner) error {
		var c domain.TypeCount
		if err := s.Scan(&c.Type, &c.Count); err != nil {
			return err
		}
		stats.ByType = append(stats.ByType, c)
		return nil
	}
	monthScan := func(s rowScanner) error {
		var c domain.MonthCount
		if err := s.Scan(&c.Month, &c.Count); err != nil {
			return err
		}
		stats.ByMonth = append(stats.ByMonth, c)
		return nil
	}
	uploaderScan := func(s rowScanner) error {
		var c domain.UploaderCount
		if err := s.Scan(&c.UploaderID, &c.UploaderName, &c.Count); err != nil {
			return err
		}
		stats.ByUploader = append(stats.ByUploader, c)
		return nil
	}
	// Extension bucket: lowercase suffix after the last dot, or a labelled fallback.
	typeSQL := " SELECT coalesce(nullif(lower(substring(f.name from '\\.([^.]*)$')),''),'(none)'),count(*) FROM files f WHERE " + predicate + " GROUP BY 1 ORDER BY 2 DESC LIMIT 20"
	if err = r.aggregate(ctx, cte+typeSQL, args, typeScan); err != nil {
		return domain.Stats{}, err
	}
	monthSQL := " SELECT to_char(date_trunc('month',f.updated_at),'YYYY-MM'),count(*) FROM files f WHERE " + predicate + " GROUP BY 1 ORDER BY 1 DESC LIMIT 12"
	if err = r.aggregate(ctx, cte+monthSQL, args, monthScan); err != nil {
		return domain.Stats{}, err
	}
	uploaderSQL := " SELECT f.uploaded_by,coalesce(u.display_name,''),count(*) FROM files f LEFT JOIN users u ON u.id=f.uploaded_by WHERE " + predicate + " GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20"
	if err = r.aggregate(ctx, cte+uploaderSQL, args, uploaderScan); err != nil {
		return domain.Stats{}, err
	}
	return stats, nil
}

func (r *Repository) aggregate(ctx context.Context, sql string, args []any, scan func(rowScanner) error) error {
	rows, err := r.Q.Query(ctx, sql, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := scan(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (r *Repository) ExportFiles(ctx context.Context, q ports.StatsQuery, limit int) ([]domain.File, error) {
	if limit <= 0 || limit > 20000 {
		return nil, domain.ErrInvalidInput
	}
	files, _, err := r.SearchFiles(ctx, ports.FileSearchQuery{
		UserID: q.UserID, GroupIDs: q.GroupIDs, FolderID: q.FolderID,
		IncludeDescendant: q.IncludeDescendant, Uploader: q.Uploader,
		MimePrefix: q.MimePrefix, From: q.From, To: q.To, Limit: limit,
	})
	return files, err
}

func backgroundCtx() context.Context { return context.Background() }

var _ = errors.Is
var _ = ports.ErrRowMissing
