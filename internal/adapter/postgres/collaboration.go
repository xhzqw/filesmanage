package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"fmt"
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
    AND NOT s.include_descendants
  UNION
  SELECT a.child AS folder_id FROM shares s JOIN ancestry a ON a.ancestor=s.folder_id
  WHERE s.folder_id IS NOT NULL AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>now())
    AND s.include_descendants
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
//
// Security (SPEC §2.3 / DB-PERF-01): an explicit folder filter never bypasses
// the visibility scope. For non-admin callers the folder restriction is
// intersected with visible_scope, so probing search/stats/export with another
// department's folder id returns nothing instead of their data.
//
// Placeholders follow the emitted bindings: the scope CTE binds $1 to the
// caller, so the folder filter takes the next free index ($2 with the CTE,
// $1 without it).
func (r *Repository) scopeFolderSQL(ctx context.Context, q ports.FileSearchQuery) (string, []any, bool, error) {
	admin, err := r.isAdmin(ctx, q.UserID)
	if err != nil {
		return "", nil, false, err
	}
	ph := newPlaceholder(0)
	if !admin {
		ph.next() // $1 is reserved for the scope CTE binding.
	}
	folderPH := ph.next()
	subtree := "f.folder_id IN (WITH RECURSIVE sub(id) AS (SELECT " + folderPH + "::text UNION ALL SELECT c.id FROM sub s JOIN folders c ON c.parent_id=s.id WHERE c.deleted_at IS NULL) SELECT id FROM sub)"
	exact := "f.folder_id=" + folderPH
	if q.FolderID == "" {
		if admin {
			return "f.folder_id IN (SELECT id FROM folders WHERE deleted_at IS NULL)", nil, false, nil
		}
		return "f.folder_id IN (SELECT folder_id FROM visible_scope)", nil, true, nil
	}
	restriction := exact
	if q.IncludeDescendant {
		restriction = subtree
	}
	if admin {
		return restriction, []any{q.FolderID}, false, nil
	}
	return "(" + restriction + " AND f.folder_id IN (SELECT folder_id FROM visible_scope))",
		[]any{q.FolderID}, true, nil
}

// placeholder assigns sequential parameters after the fixed prefix.
type placeholder struct{ n int }

func newPlaceholder(prefixCount int) *placeholder { return &placeholder{n: prefixCount} }
func (p *placeholder) next() string {
	p.n++
	return fmt.Sprintf("$%d", p.n)
}

// snippetWindow is the character window around a search match (SPEC §10.3).
const snippetWindow = 60

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
	// The text index is only joined when the query actually filters on content:
	// a plain list must not drag the wide file_text table into the plan.
	textJoin := ""
	contentColumn := "''"
	if q.Query != "" {
		textJoin = " LEFT JOIN file_text ft ON ft.file_id=f.id"
		contentColumn = "coalesce(ft.content,'')"
	}
	// Content matches run against the tsvector GIN index with the CJK-spaced
	// phrase (SPEC §10.2); the file name stays an ILIKE so name-only hits keep
	// working for unindexed or binary formats.
	if q.Query != "" {
		where = append(where, "(ft.tsv @@ phraseto_tsquery('simple', "+ph.next()+") OR f.name ILIKE "+ph.next()+")")
		args = append(args, q.TextQuery, "%"+q.Query+"%")
	}
	sql := cte + " SELECT f.id,f.folder_id,f.name,f.uploaded_by,f.content_type,f.current_version_seq,v.size_bytes,v.sha256,f.updated_at,f.deleted_at," + contentColumn + ",count(*) OVER () AS total_count" +
		" FROM files f LEFT JOIN file_versions v ON v.file_id=f.id AND v.seq=f.current_version_seq" +
		textJoin +
		" WHERE " + strings.Join(where, " AND ") + " ORDER BY " + order + " LIMIT " + fmt.Sprint(q.Limit)
	rows, err := r.Q.Query(ctx, sql, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := make([]domain.File, 0)
	total := 0
	for rows.Next() {
		f, content, filteredTotal, scanErr := scanFileWithText(rows)
		if scanErr != nil {
			return nil, 0, scanErr
		}
		total = int(filteredTotal)
		f.Snippet = domain.Snippet(content, q.Query, snippetWindow)
		out = append(out, f)
	}
	return out, total, rows.Err()
}

// scanFileWithText scans a file row, its indexed content for snippets, and the
// window count of every authorized row matching the same filters.
func scanFileWithText(row rowScanner) (domain.File, string, int64, error) {
	var f domain.File
	var content string
	var total int64
	err := row.Scan(&f.ID, &f.FolderID, &f.Name, &f.UploadedBy, &f.ContentType, &f.CurrentVersionSeq,
		&f.SizeBytes, &f.Sha256, &f.UpdatedAt, &f.DeletedAt, &content, &total)
	return f, content, total, err
}

// statsScope builds the shared predicate for aggregation queries. The context
// flows into the scope resolution so cancellation and timeouts are honoured
// (SPEC TX-09).
func (r *Repository) statsScope(ctx context.Context, q ports.StatsQuery) (cte string, predicate string, args []any, err error) {
	folderSQL, folderArgs, needsCTE, scopeErr := r.scopeFolderSQL(ctx, ports.FileSearchQuery{UserID: q.UserID, FolderID: q.FolderID, IncludeDescendant: q.IncludeDescendant})
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
	cte, predicate, args, err := r.statsScope(ctx, q)
	if err != nil {
		return domain.Stats{}, err
	}
	// Admins count every folder; non-admins resolve through the scope CTE, which
	// is emitted only when the caller has no folder filter.
	admin, adminErr := r.isAdmin(ctx, q.UserID)
	if adminErr != nil {
		return domain.Stats{}, adminErr
	}
	// The folder counter reuses the caller's folder restriction. Its parameter
	// must follow the predicate's bindings, and a non-admin scope must stay
	// intersected with the visible set so folder existence is not leaked.
	ph := newPlaceholder(len(args))
	folderScope := "d.id IN (SELECT folder_id FROM visible_scope)"
	folderArg := any(nil)
	switch {
	case q.FolderID == "" && admin:
		folderScope = "d.id IN (SELECT id FROM folders WHERE deleted_at IS NULL)"
	case q.FolderID == "":
	case q.IncludeDescendant:
		folderScope = "d.id IN (WITH RECURSIVE sub(id) AS (SELECT " + ph.next() + "::text UNION ALL SELECT c.id FROM sub s JOIN folders c ON c.parent_id=s.id WHERE c.deleted_at IS NULL) SELECT id FROM sub)"
		folderArg = q.FolderID
	default:
		folderScope = "d.id=" + ph.next()
		folderArg = q.FolderID
	}
	if !admin {
		folderScope += " AND d.id IN (SELECT folder_id FROM visible_scope)"
	}
	// The aggregate breakdowns below only bind the predicate's parameters; the
	// folder counter's parameter is appended for the summary query alone.
	scopeArgs := args
	if folderArg != nil {
		args = append(args, folderArg)
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
	if err = r.aggregate(ctx, cte+typeSQL, scopeArgs, typeScan); err != nil {
		return domain.Stats{}, err
	}
	monthSQL := " SELECT to_char(date_trunc('month',f.updated_at),'YYYY-MM'),count(*) FROM files f WHERE " + predicate + " GROUP BY 1 ORDER BY 1 DESC LIMIT 12"
	if err = r.aggregate(ctx, cte+monthSQL, scopeArgs, monthScan); err != nil {
		return domain.Stats{}, err
	}
	uploaderSQL := " SELECT f.uploaded_by,coalesce(u.display_name,''),count(*) FROM files f LEFT JOIN users u ON u.id=f.uploaded_by WHERE " + predicate + " GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20"
	if err = r.aggregate(ctx, cte+uploaderSQL, scopeArgs, uploaderScan); err != nil {
		return domain.Stats{}, err
	}
	return stats, nil
}

// FolderSharesForSubject returns the folder shares that apply to folderID for
// the user or their workgroups: the share on the folder itself plus, when
// include_descendants is set, shares on any ancestor. The same rule the
// search scope CTE applies, so direct reads and search agree (SPEC §2.4).
func (r *Repository) FolderSharesForSubject(ctx context.Context, userID string, groupIDs []string, folderID string) ([]domain.Share, error) {
	rows, err := r.Q.Query(ctx,
		`WITH RECURSIVE anc(id,parent_id,depth) AS (
		   SELECT f.id,f.parent_id,0 FROM folders f WHERE f.id=$3
		   UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM anc a JOIN folders p ON p.id=a.parent_id
		 )
		 `+shareSelect+` JOIN anc a ON s.folder_id=a.id
		 WHERE s.folder_id IS NOT NULL AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>now())
		   AND (s.include_descendants OR a.depth=0)
		   AND ((s.recipient_kind='user' AND s.recipient_id=$1)
		     OR (s.recipient_kind='group' AND s.recipient_id=ANY($2::text[])))`,
		userID, groupIDs, folderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Share, 0)
	for rows.Next() {
		share, err := scanShare(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, share)
	}
	return out, rows.Err()
}

// FileSharesForSubject returns the active file-level shares for a file.
func (r *Repository) FileSharesForSubject(ctx context.Context, userID string, groupIDs []string, fileID string) ([]domain.Share, error) {
	rows, err := r.Q.Query(ctx,
		shareSelect+` WHERE s.file_id=$3 AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>now())
		   AND ((s.recipient_kind='user' AND s.recipient_id=$1)
		     OR (s.recipient_kind='group' AND s.recipient_id=ANY($2::text[])))`,
		userID, groupIDs, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Share, 0)
	for rows.Next() {
		share, err := scanShare(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, share)
	}
	return out, rows.Err()
}

// UpsertFileText stores the current version's indexed text (SPEC §10.1). The
// composite FK (file_id,current_seq) is deferred, so callers write it after the
// version row exists in the same transaction.
func (r *Repository) UpsertFileText(ctx context.Context, fileID string, seq int, content, spaced string) error {
	_, err := r.Q.Exec(ctx,
		`INSERT INTO file_text(file_id,current_seq,content,spaced) VALUES ($1,$2,$3,$4)
		 ON CONFLICT (file_id) DO UPDATE SET current_seq=EXCLUDED.current_seq,
		   content=EXCLUDED.content, spaced=EXCLUDED.spaced`,
		fileID, seq, content, spaced)
	return err
}

// FileIDsMissingText lists active files that still need an index row, oldest
// update first, so the backfill tool can work in bounded batches.
func (r *Repository) FileIDsMissingText(ctx context.Context, limit int) ([]string, error) {
	rows, err := r.Q.Query(ctx,
		`SELECT f.id FROM files f LEFT JOIN file_text t ON t.file_id=f.id
		 WHERE f.deleted_at IS NULL AND t.file_id IS NULL
		 ORDER BY f.updated_at ASC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
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

// ExportFilesStream streams every authorized export row for the filter (SPEC
// §3.10, READ-06, PE07). The result set is never materialised: rows are read
// through the driver's cursor and handed to yield one at a time, so a 100k-row
// export keeps a flat memory profile. The visible folder path is computed with
// a recursive walk over the caller's visible set only — invisible ancestors
// never appear in the exported path.
func (r *Repository) ExportFilesStream(ctx context.Context, q ports.StatsQuery, yield func(ports.ExportRow) error) error {
	cte, predicate, args, err := r.statsScope(ctx, q)
	if err != nil {
		return err
	}
	admin, adminErr := r.isAdmin(ctx, q.UserID)
	if adminErr != nil {
		return adminErr
	}
	visible := "(SELECT folder_id FROM visible_scope)"
	if admin {
		visible = "(SELECT id FROM folders WHERE deleted_at IS NULL)"
	}
	// Path roots are visible folders whose parent is invisible (or the root):
	// this mirrors the folder tree, where a granted folder below an invisible
	// ancestor renders at the top level instead of exposing that ancestor.
	with := cte
	if with == "" {
		with = "WITH RECURSIVE"
	} else {
		with += ","
	}
	sql := with + ` vis AS (SELECT id FROM folders f WHERE f.deleted_at IS NULL AND f.id IN ` + visible + `),
	folder_paths AS (
	  SELECT f.id, CAST(f.name AS text) AS path FROM folders f
	   WHERE f.deleted_at IS NULL AND f.id IN (SELECT id FROM vis)
	     AND (f.parent_id IS NULL OR f.parent_id NOT IN (SELECT id FROM vis))
	  UNION ALL
	  SELECT f.id, p.path || '/' || f.name FROM folders f JOIN folder_paths p ON f.parent_id=p.id
	   WHERE f.deleted_at IS NULL AND f.id IN (SELECT id FROM vis)
	)
	SELECT f.id, fp.path, f.name, f.uploaded_by, coalesce(u.display_name,''),
	       coalesce(v.size_bytes,0), coalesce(f.current_version_seq,0), f.updated_at
	  FROM files f
	  JOIN folder_paths fp ON fp.id=f.folder_id
	  LEFT JOIN users u ON u.id=f.uploaded_by
	  LEFT JOIN file_versions v ON v.file_id=f.id AND v.seq=f.current_version_seq
	 WHERE ` + predicate + `
	 ORDER BY f.updated_at DESC, f.id DESC`
	rows, err := r.Q.Query(ctx, sql, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var row ports.ExportRow
		if err = rows.Scan(&row.FileID, &row.Path, &row.Name, &row.UploaderID, &row.UploaderName,
			&row.SizeBytes, &row.VersionSeq, &row.UpdatedAt); err != nil {
			return err
		}
		if err = yield(row); err != nil {
			return err
		}
	}
	return rows.Err()
}

func backgroundCtx() context.Context { return context.Background() }

var _ = errors.Is
var _ = ports.ErrRowMissing
