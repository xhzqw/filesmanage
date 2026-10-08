package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"fmt"
	"sort"
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
	// Two-phase read: a narrow pre-sort over the matching ids carries the exact
	// window count, and only the page's rows join versions and the wide text
	// index (SPEC §10.2/READ-07). Joining file_text first would drag 100k wide
	// rows through the sort for every search.
	textColumn := "''"
	if q.Query != "" {
		textColumn = "coalesce(ft.content,'')"
	}
	// Content matches run against the tsvector GIN index with the CJK-spaced
	// phrase; the file name stays an ILIKE so name-only hits keep working for
	// unindexed or binary formats.
	if q.Query != "" {
		// EXISTS (not IN) lets the planner drive from the export order index
		// with early termination on LIMIT instead of hashing the whole match
		// set and sorting it: a broad term over 100k files drops from ~500ms
		// to ~140ms, and selective terms still use the GIN index.
		where = append(where, "(EXISTS (SELECT 1 FROM file_text ft WHERE ft.file_id=f.id AND ft.tsv @@ phraseto_tsquery('simple', "+ph.next()+")) OR f.name ILIKE "+ph.next()+")")
		args = append(args, q.TextQuery, "%"+q.Query+"%")
	}
	matchedOrder := "f.updated_at DESC,f.id DESC"
	outerOrder := "m.updated_at DESC,m.id DESC"
	matchedJoin := ""
	switch q.Sort {
	case "", "updated_desc":
	case "name_asc":
		matchedOrder = "f.name ASC,f.id ASC"
		outerOrder = "m.name ASC,m.id ASC"
	case "size_desc":
		matchedJoin = " LEFT JOIN file_versions v ON v.file_id=f.id AND v.seq=f.current_version_seq"
		matchedOrder = "v.size_bytes DESC NULLS LAST,f.id DESC"
		outerOrder = "v.size_bytes DESC NULLS LAST,m.id DESC"
	default:
		return nil, 0, domain.ErrInvalidInput
	}
	// The authorized total is a dedicated count query, hard-capped at
	// searchTotalCap (SPEC §10.2 permits a capped total). Keeping it out of the
	// page query matters: a window count would materialise the whole match set
	// and destroy the early-terminating ordered index scan, and an uncapped
	// count over a broad term costs ~1s on 100k files. A result of
	// searchTotalCap means "searchTotalCap-1 or more"; the transport surfaces
	// it as "1000+".
	const searchTotalCap = 1001
	total := 0
	if err = r.Q.QueryRow(ctx, cte+" SELECT count(*) FROM (SELECT f.id FROM files f WHERE "+strings.Join(where, " AND ")+" LIMIT "+fmt.Sprint(searchTotalCap)+") t", args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	with := cte
	if with == "" {
		with = "WITH"
	} else {
		with += ","
	}
	// matched carries the sort keys the outer ORDER BY references.
	sql := with + ` matched AS (
	  SELECT f.id,f.updated_at,f.name
	    FROM files f` + matchedJoin + `
	   WHERE ` + strings.Join(where, " AND ") + `
	   ORDER BY ` + matchedOrder + ` LIMIT ` + fmt.Sprint(q.Limit) + `
	)
	SELECT f.id,f.folder_id,f.name,f.uploaded_by,f.content_type,f.current_version_seq,v.size_bytes,v.sha256,f.updated_at,f.deleted_at,` + textColumn + `
	  FROM matched m
	  JOIN files f ON f.id=m.id
	  LEFT JOIN file_versions v ON v.file_id=f.id AND v.seq=f.current_version_seq
	  LEFT JOIN file_text ft ON ft.file_id=f.id
	 ORDER BY ` + outerOrder
	rows, err := r.Q.Query(ctx, sql, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := make([]domain.File, 0)
	for rows.Next() {
		f, content, scanErr := scanFileWithText(rows)
		if scanErr != nil {
			return nil, 0, scanErr
		}
		f.Snippet = domain.Snippet(content, q.Query, snippetWindow)
		out = append(out, f)
	}
	return out, total, rows.Err()
}

// scanFileWithText scans a file row plus its indexed content for snippets.
func scanFileWithText(row rowScanner) (domain.File, string, error) {
	var f domain.File
	var content string
	err := row.Scan(&f.ID, &f.FolderID, &f.Name, &f.UploadedBy, &f.ContentType, &f.CurrentVersionSeq,
		&f.SizeBytes, &f.Sha256, &f.UpdatedAt, &f.DeletedAt, &content)
	return f, content, err
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
	// Summary and folder count in one round trip: the three file figures are
	// FILTER aggregates over a single scan instead of three separate ones.
	var stats domain.Stats
	summary := cte + ` SELECT f.total_files, f.added_30, f.total_bytes, d.total_folders FROM (
	  SELECT count(*) AS total_files,
	         count(*) FILTER (WHERE f.updated_at>now()-interval '30 days') AS added_30,
	         coalesce(sum(v.size_bytes),0) AS total_bytes
	    FROM files f LEFT JOIN file_versions v ON v.file_id=f.id AND v.seq=f.current_version_seq
	   WHERE ` + predicate + `
	) f, (
	  SELECT count(*) AS total_folders FROM folders d
	   WHERE d.deleted_at IS NULL AND ` + folderScope + `
	) d`
	if err = r.Q.QueryRow(ctx, summary, args...).Scan(&stats.TotalFiles, &stats.Added30Days, &stats.TotalBytes, &stats.TotalFolders); err != nil {
		return domain.Stats{}, err
	}
	// Breakdowns in one scan via GROUPING SETS: extension buckets, month
	// buckets and uploader buckets come back tagged by which grouping column
	// is present, so three GROUP BY passes collapse into one.
	breakdown := " SELECT coalesce(nullif(lower(substring(f.name from '\\\\.([^.]*)$')),''),'(none)') AS ext," +
		" to_char(date_trunc('month',f.updated_at),'YYYY-MM') AS mon," +
		" f.uploaded_by, coalesce(u.display_name,'') AS uploader_name, count(*) AS n" +
		" FROM files f LEFT JOIN users u ON u.id=f.uploaded_by" +
		" WHERE " + predicate +
		" GROUP BY GROUPING SETS ((ext),(mon),(f.uploaded_by,uploader_name))"
	rows, err := r.Q.Query(ctx, cte+breakdown, scopeArgs...)
	if err != nil {
		return domain.Stats{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var ext, mon, uploaderID, uploaderName *string
		var n int64
		if err = rows.Scan(&ext, &mon, &uploaderID, &uploaderName, &n); err != nil {
			return domain.Stats{}, err
		}
		switch {
		case ext != nil:
			stats.ByType = append(stats.ByType, domain.TypeCount{Type: *ext, Count: n})
		case mon != nil:
			stats.ByMonth = append(stats.ByMonth, domain.MonthCount{Month: *mon, Count: n})
		case uploaderID != nil:
			name := ""
			if uploaderName != nil {
				name = *uploaderName
			}
			stats.ByUploader = append(stats.ByUploader, domain.UploaderCount{UploaderID: *uploaderID, UploaderName: name, Count: n})
		}
	}
	if err = rows.Err(); err != nil {
		return domain.Stats{}, err
	}
	sortTypeCounts(stats.ByType)
	sortMonthCounts(stats.ByMonth)
	sortUploaderCounts(stats.ByUploader)
	if len(stats.ByType) > 20 {
		stats.ByType = stats.ByType[:20]
	}
	if len(stats.ByMonth) > 12 {
		stats.ByMonth = stats.ByMonth[:12]
	}
	if len(stats.ByUploader) > 20 {
		stats.ByUploader = stats.ByUploader[:20]
	}
	return stats, nil
}

// Breakdown orderings: count descending, then the bucket label for stability.
func sortTypeCounts(items []domain.TypeCount) {
	sort.Slice(items, func(i, j int) bool {
		if items[i].Count != items[j].Count {
			return items[i].Count > items[j].Count
		}
		return items[i].Type < items[j].Type
	})
}

func sortMonthCounts(items []domain.MonthCount) {
	sort.Slice(items, func(i, j int) bool {
		if items[i].Count != items[j].Count {
			return items[i].Count > items[j].Count
		}
		return items[i].Month > items[j].Month
	})
}

func sortUploaderCounts(items []domain.UploaderCount) {
	sort.Slice(items, func(i, j int) bool {
		if items[i].Count != items[j].Count {
			return items[i].Count > items[j].Count
		}
		return items[i].UploaderID < items[j].UploaderID
	})
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

// ExportFilesStream streams every authorized export row for the filter (SPEC
// §3.10, READ-06, PE07). The result set is never materialised: phase one reads
// only the ordered ids, the visible folder paths are resolved once into a
// bounded map, and each batch of rows is then served by primary-key lookups,
// so a 100k-row export keeps a flat memory profile and starts delivering after
// the first batch (IO-PERF-03 first-byte budget).
const exportBatchSize = 500

func (r *Repository) ExportFilesStream(ctx context.Context, q ports.StatsQuery, yield func(ports.ExportRow) error) error {
	admin, adminErr := r.isAdmin(ctx, q.UserID)
	if adminErr != nil {
		return adminErr
	}
	scope := ""
	visible := "(SELECT id FROM folders WHERE deleted_at IS NULL)"
	scopeArgs := []any{}
	if !admin {
		scope = scopeCTE
		visible = "(SELECT folder_id FROM visible_scope)"
		// The scope CTE binds $1 to the caller.
		scopeArgs = append(scopeArgs, q.UserID)
	}
	// Visible folder paths, resolved once. Roots are visible folders whose
	// parent is invisible (or the root): this mirrors the folder tree, where a
	// granted folder below an invisible ancestor renders at the top level
	// instead of exposing that ancestor.
	paths, err := r.visibleFolderPaths(ctx, scope, visible, scopeArgs)
	if err != nil {
		return err
	}
	// Phase one: ordered ids with the caller's filters only. The visibility
	// scope is enforced in phase two through the visible-folder path map, which
	// keeps this scan on the export order index instead of paying for a
	// semi-join plus sort over the whole table before the first row can be
	// written. No unauthorized row can reach the client: phase two drops every
	// file whose folder is not in the visible map (SPEC DB-PERF-01).
	filterWhere := []string{"f.deleted_at IS NULL"}
	filterArgs := []any{}
	fph := newPlaceholder(0)
	if q.FolderID != "" {
		if q.IncludeDescendant {
			filterWhere = append(filterWhere, "f.folder_id IN (WITH RECURSIVE sub(id) AS (SELECT "+fph.next()+"::text UNION ALL SELECT c.id FROM sub s JOIN folders c ON c.parent_id=s.id WHERE c.deleted_at IS NULL) SELECT id FROM sub)")
		} else {
			filterWhere = append(filterWhere, "f.folder_id="+fph.next())
		}
		filterArgs = append(filterArgs, q.FolderID)
	}
	if q.Uploader != "" {
		filterWhere = append(filterWhere, "f.uploaded_by="+fph.next())
		filterArgs = append(filterArgs, q.Uploader)
	}
	if q.MimePrefix != "" {
		filterWhere = append(filterWhere, "f.content_type LIKE "+fph.next())
		filterArgs = append(filterArgs, q.MimePrefix+"%")
	}
	if q.From != nil {
		filterWhere = append(filterWhere, "f.updated_at>="+fph.next())
		filterArgs = append(filterArgs, *q.From)
	}
	if q.To != nil {
		filterWhere = append(filterWhere, "f.updated_at<="+fph.next())
		filterArgs = append(filterArgs, *q.To)
	}
	idRows, err := r.Q.Query(ctx,
		" SELECT f.id FROM files f WHERE "+strings.Join(filterWhere, " AND ")+" ORDER BY f.updated_at DESC, f.id DESC",
		filterArgs...)
	if err != nil {
		return err
	}
	ids := make([]string, 0, 1024)
	for idRows.Next() {
		var id string
		if err = idRows.Scan(&id); err != nil {
			idRows.Close()
			return err
		}
		ids = append(ids, id)
	}
	if err = idRows.Err(); err != nil {
		idRows.Close()
		return err
	}
	idRows.Close()
	// Phase two: each batch is served by primary-key lookups and yielded in the
	// phase-one order. Files whose folder left the visible set between phases
	// are skipped rather than exported with a leaked path.
	batchSQL := `SELECT f.id,f.folder_id,f.name,f.uploaded_by,f.updated_at,coalesce(u.display_name,''),
	       coalesce(v.size_bytes,0),coalesce(f.current_version_seq,0)
	  FROM files f
	  LEFT JOIN users u ON u.id=f.uploaded_by
	  LEFT JOIN file_versions v ON v.file_id=f.id AND v.seq=f.current_version_seq
	 WHERE f.id = ANY($1::text[])`
	for start := 0; start < len(ids); start += exportBatchSize {
		finish := start + exportBatchSize
		if finish > len(ids) {
			finish = len(ids)
		}
		batch := ids[start:finish]
		rows, queryErr := r.Q.Query(ctx, batchSQL, batch)
		if queryErr != nil {
			return queryErr
		}
		byID := make(map[string]ports.ExportRow, len(batch))
		for rows.Next() {
			var row ports.ExportRow
			var folderID string
			// Column order matches batchSQL: id, folder, name, uploader,
			// updatedAt, uploaderName, size, current seq.
			if scanErr := rows.Scan(&row.FileID, &folderID, &row.Name, &row.UploaderID, &row.UpdatedAt,
				&row.UploaderName, &row.SizeBytes, &row.VersionSeq); scanErr != nil {
				rows.Close()
				return scanErr
			}
			path, visiblePath := paths[folderID]
			if !visiblePath {
				continue
			}
			row.Path = path
			byID[row.FileID] = row
		}
		if rowsErr := rows.Err(); rowsErr != nil {
			rows.Close()
			return rowsErr
		}
		rows.Close()
		for _, id := range batch {
			row, ok := byID[id]
			if !ok {
				continue
			}
			if yieldErr := yield(row); yieldErr != nil {
				return yieldErr
			}
		}
	}
	return nil
}

// visibleFolderPaths resolves every visible folder's path once per export.
func (r *Repository) visibleFolderPaths(ctx context.Context, cte, visible string, args []any) (map[string]string, error) {
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
	SELECT id, path FROM folder_paths`
	rows, err := r.Q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	paths := make(map[string]string, 1024)
	for rows.Next() {
		var id, path string
		if err = rows.Scan(&id, &path); err != nil {
			return nil, err
		}
		paths[id] = path
	}
	return paths, rows.Err()
}

func backgroundCtx() context.Context { return context.Background() }

var _ = errors.Is
var _ = ports.ErrRowMissing
