package application

import (
	"context"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"fmt"
	"strings"
	"time"
)

// Collaboration use cases: shares, favorites, search, stats and CSV export.
// Every read goes through the shared visibility scope (SPEC READ-01), so a
// feature can never compute its own permission model.

// ---------- shares ----------

func (s *Service) ListShares(ctx context.Context, u domain.User, scope string) ([]domain.Share, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	switch scope {
	case "received":
		groups, gErr := tx.WorkgroupsOf(ctx, u.ID)
		if gErr != nil {
			return nil, gErr
		}
		return tx.ListSharesForSubject(ctx, u.ID, groups)
	case "sent":
		if !u.IsAdmin {
			return nil, domain.ErrForbidden
		}
		return tx.ListSharesCreatedBy(ctx, u.ID)
	default:
		return nil, domain.ErrInvalidInput
	}
}

type ShareDraft struct {
	ResourceKind       string
	ResourceID         string
	RecipientKind      string
	RecipientID        string
	Actions            []domain.Action
	IncludeDescendants bool
	ExpiresAt          *time.Time
}

// CreateShare is a management capability, not a consequence of list/preview.
// In the absence of delegated manage_share roles only system admins and
// resource owners may share, and non-admin owners cannot delegate actions
// they cannot perform themselves.
func (s *Service) CreateShare(ctx context.Context, u domain.User, draft ShareDraft) (domain.Share, error) {
	if (draft.ResourceKind != "file" && draft.ResourceKind != "folder") || draft.ResourceID == "" {
		return domain.Share{}, domain.ErrInvalidInput
	}
	if len(draft.Actions) == 0 || (draft.RecipientKind != "user" && draft.RecipientKind != "group") {
		return domain.Share{}, domain.ErrInvalidInput
	}
	for _, action := range draft.Actions {
		if action != domain.ActionList && action != domain.ActionPreview && action != domain.ActionDownload {
			return domain.Share{}, domain.ErrInvalidInput
		}
	}
	// A subtree share applies to descendants regardless of their own ACLs.
	// The owner of the parent alone cannot prove rights on every descendant.
	// Until scoped manage_share delegation exists, only admin may create one.
	if !u.IsAdmin && draft.ResourceKind == "folder" && draft.IncludeDescendants {
		return domain.Share{}, domain.ErrForbidden
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.Share{}, err
	}
	defer tx.Rollback(ctx)
	if err = s.assertRecipientExists(ctx, tx, draft.RecipientKind, draft.RecipientID); err != nil {
		return domain.Share{}, err
	}
	share := domain.Share{
		ID: NewID("share"), RecipientKind: draft.RecipientKind, RecipientID: draft.RecipientID,
		Actions: draft.Actions, IncludeDescendants: draft.IncludeDescendants,
		ExpiresAt: draft.ExpiresAt, CreatedBy: u.ID, CreatedAt: s.now(),
	}
	if draft.ResourceKind == "file" {
		fileID := draft.ResourceID
		share.FileID = &fileID
		file, fileErr := tx.FileByID(ctx, fileID)
		if fileErr != nil || file.DeletedAt != nil {
			return domain.Share{}, domain.ErrNotFound
		}
		if _, err = s.activeFolder(ctx, tx, file.FolderID); err != nil {
			return domain.Share{}, err
		}
		if !u.IsAdmin && file.UploadedBy != u.ID {
			return domain.Share{}, domain.ErrForbidden
		}
		for _, action := range draft.Actions {
			if _, err = s.visibleFile(ctx, tx, u, fileID, action); err != nil {
				return domain.Share{}, err
			}
		}
	} else {
		folderID := draft.ResourceID
		share.FolderID = &folderID
		folder, fErr := s.activeFolder(ctx, tx, folderID)
		if fErr != nil {
			return domain.Share{}, fErr
		}
		if !u.IsAdmin && folder.OwnerID != u.ID {
			return domain.Share{}, domain.ErrForbidden
		}
		for _, action := range draft.Actions {
			if err = s.require(ctx, tx, u, folder.ID, action); err != nil {
				return domain.Share{}, err
			}
		}
	}
	if err = tx.CreateShare(ctx, share); err != nil {
		return domain.Share{}, mapError(err)
	}
	if err = auditRequired(ctx, tx, u, "share.create", draft.ResourceKind, draft.ResourceID, "success",
		map[string]any{"before": nil, "after": shareAuditState(share)}); err != nil {
		return domain.Share{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.Share{}, err
	}
	// Authorisation just changed: drop every cached read so the next
	// request sees the new scope (PE04).
	s.bumpACLEpoch()

	return share, nil
}

func (s *Service) RevokeShare(ctx context.Context, u domain.User, shareID string) error {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	share, err := tx.ShareByID(ctx, shareID)
	if err != nil {
		return notFoundOr(err)
	}
	if share.CreatedBy != u.ID && !u.IsAdmin {
		return domain.ErrForbidden
	}
	if err = tx.RevokeShare(ctx, shareID); err != nil {
		return err
	}
	prior := shareAuditState(share)
	share.RevokedAt = new(time.Time)
	if err = auditRequired(ctx, tx, u, "share.revoke", "share", shareID, "success",
		map[string]any{"before": prior, "after": shareAuditState(share)}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.bumpACLEpoch()
	return nil
}

func (s *Service) assertRecipientExists(ctx context.Context, repo subjectProbe, kind, id string) error {
	switch kind {
	case "user":
		found, err := repo.UserExists(ctx, id)
		if err != nil {
			return err
		}
		if !found {
			return domain.ErrInvalidInput
		}
	case "group":
		found, err := repo.WorkgroupExists(ctx, id)
		if err != nil {
			return err
		}
		if !found {
			return domain.ErrInvalidInput
		}
	default:
		return domain.ErrInvalidInput
	}
	return nil
}

type subjectProbe interface {
	UserExists(context.Context, string) (bool, error)
	WorkgroupExists(context.Context, string) (bool, error)
}

// ShareRecipient is the minimal share-target row the share wizard renders
// (COMPLEX-WORKFLOWS §9, WF-21): an id plus the display label. Account details
// (login, department, admin flag) stay behind the admin user directory.
type ShareRecipient struct {
	ID   string
	Name string
}

// ShareRecipientPage is a recipient list truncated at the read cap. Truncated
// reports that more matches exist without disclosing how many, so the picker
// can ask for a narrower query instead of paging a directory.
type ShareRecipientPage struct {
	Items     []ShareRecipient
	Truncated bool
}

// Recipient reads stay hard-capped so the endpoint cannot serve as a general
// user directory (WF-21).
const (
	shareRecipientDefaultLimit = 50
	shareRecipientMaxLimit     = 200
)

// ShareRecipients lists the subjects a share may target. Any authenticated
// session may read it — creating a share only requires the recipient to exist —
// so the caller's role grants nothing extra and the resolved user is accepted
// only to keep the use-case API uniform. Disabled accounts are excluded: a
// share to a disabled account is rejected at creation time
// (assertRecipientExists), so it must not be offered here either. The read
// reuses the organization stores, so the recipient rule never forks.
func (s *Service) ShareRecipients(ctx context.Context, _ domain.User, kind, query string, limit int) (ShareRecipientPage, error) {
	if kind != "user" && kind != "group" {
		return ShareRecipientPage{}, domain.ErrInvalidInput
	}
	if limit <= 0 {
		limit = shareRecipientDefaultLimit
	}
	if limit > shareRecipientMaxLimit {
		limit = shareRecipientMaxLimit
	}
	needle := strings.ToLower(strings.TrimSpace(query))
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return ShareRecipientPage{}, err
	}
	defer tx.Rollback(ctx)
	page := ShareRecipientPage{Items: make([]ShareRecipient, 0)}
	switch kind {
	case "user":
		users, listErr := tx.ListUsers(ctx)
		if listErr != nil {
			return ShareRecipientPage{}, listErr
		}
		for _, item := range users {
			if item.DisabledAt != nil {
				continue
			}
			if needle != "" && !strings.Contains(strings.ToLower(item.DisplayName), needle) {
				continue
			}
			page.Items = append(page.Items, ShareRecipient{ID: item.ID, Name: item.DisplayName})
		}
	case "group":
		groups, listErr := tx.ListWorkgroups(ctx)
		if listErr != nil {
			return ShareRecipientPage{}, listErr
		}
		for _, item := range groups {
			if needle != "" && !strings.Contains(strings.ToLower(item.Name), needle) {
				continue
			}
			page.Items = append(page.Items, ShareRecipient{ID: item.ID, Name: item.Name})
		}
	}
	if len(page.Items) > limit {
		page.Items = page.Items[:limit]
		page.Truncated = true
	}
	return page, nil
}

// ---------- favorites ----------

func (s *Service) ListFavorites(ctx context.Context, u domain.User) ([]domain.Favorite, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	items, err := tx.ListFavorites(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	if err := s.markUnavailableFavorites(ctx, tx, u, items); err != nil {
		return nil, err
	}
	return items, nil
}

// SetFavorite adds or removes a favorite idempotently.
func (s *Service) SetFavorite(ctx context.Context, u domain.User, kind, resourceID string, on bool) error {
	if (kind != "file" && kind != "folder") || resourceID == "" {
		return domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Adding requires current access. Removing one's own saved favorite is
	// allowed even after deletion or permission revocation, otherwise stale
	// entries would be impossible to clean up from the UI.
	if on {
		if kind == "file" {
			if _, err = s.visibleFile(ctx, tx, u, resourceID, domain.ActionPreview); err != nil {
				return err
			}
		} else {
			folder, fErr := s.activeFolder(ctx, tx, resourceID)
			if fErr != nil {
				return fErr
			}
			if err = s.require(ctx, tx, u, folder.ID, domain.ActionList); err != nil {
				return err
			}
		}
	}
	fileID, folderID := "", ""
	if kind == "file" {
		fileID = resourceID
	} else {
		folderID = resourceID
	}
	exists, err := tx.FavoriteExists(ctx, u.ID, fileID, folderID)
	if err != nil {
		return err
	}
	if on {
		if exists {
			return nil // idempotent
		}
		if err = tx.AddFavorite(ctx, domain.Favorite{ID: NewID("fav"), UserID: u.ID, FileID: optional(fileID), FolderID: optional(folderID), CreatedAt: s.now()}); err != nil {
			return err
		}
	} else {
		if !exists {
			return nil // idempotent
		}
		if err = tx.RemoveFavorite(ctx, u.ID, fileID, folderID); err != nil {
			return err
		}
	}
	audit(ctx, tx, u, "favorite.set", kind, resourceID, "success", map[string]any{"on": on})
	return tx.Commit(ctx)
}

func statsQuery(u domain.User, groups []string, filter SearchFilter) ports.StatsQuery {
	return ports.StatsQuery{
		UserID: u.ID, GroupIDs: groups, FolderID: filter.FolderID,
		IncludeDescendant: filter.IncludeDescendant, Uploader: filter.Uploader,
		MimePrefix: filter.MimePrefix, From: filter.From, To: filter.To,
	}
}

func optional(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}

// ---------- search, stats and export ----------

type SearchFilter struct {
	FolderID          string
	IncludeDescendant bool
	Query             string
	Category          string
	Tag               string
	Uploader          string
	MimePrefix        string
	From              *time.Time
	To                *time.Time
	Sort              string
	// Cursor is the opaque nextCursor of the previous page (WF-30); empty
	// starts at the first page, and a cursor the server did not issue restarts
	// there too instead of failing the read.
	Cursor string
	Limit  int
}

// SearchPage is one page of authorized search results: the keyset cursor for
// the next page ("" on the last page) and the authorized total for the whole
// filter, which does not shrink as the caller pages.
type SearchPage struct {
	Items      []domain.File
	Total      int
	NextCursor string
}

func (s *Service) Search(ctx context.Context, u domain.User, filter SearchFilter) (SearchPage, error) {
	if filter.Limit <= 0 {
		filter.Limit = 50
	}
	if filter.Limit > ports.MaxSearchPage {
		filter.Limit = ports.MaxSearchPage
	}
	// Repeated identical queries are memoised for a short TTL. The key carries
	// the principal and the whole filter — including the page cursor — so a
	// cached page is only ever served to the same user with the same scope and
	// page; the TTL bounds how long a newly uploaded file can be missing from
	// results.
	// The epoch invalidates every cached read the moment authorisation
	// changes, so a revocation or a new grant is visible on the next request
	// (PE04) instead of after the TTL.
	key := fmt.Sprintf("%d|%s", s.epoch(), searchCacheKey(u, filter))
	if cached, ok := s.search.get(key, s.now()); ok {
		return SearchPage{Items: cached.files, Total: cached.total, NextCursor: cached.nextCursor}, nil
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return SearchPage{}, err
	}
	defer tx.Rollback(ctx)
	groups, err := tx.WorkgroupsOf(ctx, u.ID)
	if err != nil {
		return SearchPage{}, err
	}
	// The repository read carries one lookahead row beyond the page so a full
	// page can be told apart from the last one, exactly like the file list
	// (WF-30).
	files, total, err := tx.SearchFiles(ctx, searchQuery(u, groups, filter))
	if err != nil {
		return SearchPage{}, err
	}
	page := SearchPage{Items: files, Total: total}
	if len(files) > filter.Limit {
		page.Items = files[:filter.Limit]
		page.NextCursor = encodeCursor(filter.Sort, files[filter.Limit-1])
	}
	s.search.put(key, searchEntryValue{files: page.Items, total: page.Total, nextCursor: page.NextCursor}, s.now())
	return page, nil
}

// searchCacheKey binds the caller's identity, admin flag and the whole filter
// (query, folder, descendant flag, uploader, mime prefix, time range, sort,
// page cursor and limit), so no two users, scopes or pages can share a cached
// entry.
func searchCacheKey(u domain.User, filter SearchFilter) string {
	raw, err := json.Marshal(struct {
		UserID            string
		Admin             bool
		Query             string
		Category          string
		Tag               string
		FolderID          string
		IncludeDescendant bool
		Uploader          string
		MimePrefix        string
		From              *time.Time
		To                *time.Time
		Sort              string
		Cursor            string
		Limit             int
	}{u.ID, u.IsAdmin, filter.Query, filter.Category, filter.Tag, filter.FolderID, filter.IncludeDescendant,
		filter.Uploader, filter.MimePrefix, filter.From, filter.To, filter.Sort, filter.Cursor, filter.Limit})
	if err != nil {
		return NewID("search-uncacheable")
	}
	return string(raw)
}

// searchQuery maps the filter onto the shared repository query. Each supported
// sort pages on its own ordering keys: the cursor decodes to the key matching
// filter.Sort and a cursor the server did not issue decodes to the zero value,
// which restarts at page one.
func searchQuery(u domain.User, groups []string, filter SearchFilter) ports.FileSearchQuery {
	cursor := DecodeFileCursor(filter.Sort, filter.Cursor)
	return ports.FileSearchQuery{
		UserID: u.ID, GroupIDs: groups, FolderID: filter.FolderID,
		IncludeDescendant: filter.IncludeDescendant, Query: filter.Query,
		Category: filter.Category, Tag: filter.Tag,
		// The tsvector index is built from the CJK-spaced text; the query is
		// spaced the same way so phraseto_tsquery keeps adjacency (SPEC §10.2).
		TextQuery: SpaceCJK(filter.Query),
		Uploader:  filter.Uploader, MimePrefix: filter.MimePrefix,
		From: filter.From, To: filter.To, Sort: filter.Sort,
		CursorTime: cursor.Time, CursorRank: cursor.Rank, CursorName: cursor.Name, CursorID: cursor.ID, CursorSize: cursor.Size,
		// One lookahead row beyond the page tells the service whether more
		// matches exist (WF-30), the same convention the file list uses.
		Limit: filter.Limit + 1,
	}
}

func (s *Service) Stats(ctx context.Context, u domain.User, filter SearchFilter) (domain.Stats, error) {
	key := fmt.Sprintf("%d|%s", s.epoch(), statsCacheKey(u, filter))
	if cached, ok := s.stats.get(key, s.now()); ok {
		return cached, nil
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.Stats{}, err
	}
	defer tx.Rollback(ctx)
	groups, err := tx.WorkgroupsOf(ctx, u.ID)
	if err != nil {
		return domain.Stats{}, err
	}
	stats, err := tx.Stats(ctx, statsQuery(u, groups, filter))
	if err != nil {
		return domain.Stats{}, err
	}
	// Only successful aggregations are memoised; a failed one must retry.
	s.stats.put(key, stats, s.now())
	return stats, nil
}

// statsCacheKey binds the caller's identity, admin flag and the whole filter,
// so two users (or two scopes) never share an entry.
func statsCacheKey(u domain.User, filter SearchFilter) string {
	raw, err := json.Marshal(struct {
		UserID            string
		Admin             bool
		FolderID          string
		IncludeDescendant bool
		Uploader          string
		MimePrefix        string
		From              *time.Time
		To                *time.Time
	}{u.ID, u.IsAdmin, filter.FolderID, filter.IncludeDescendant, filter.Uploader,
		filter.MimePrefix, filter.From, filter.To})
	if err != nil {
		// A filter that cannot be serialised must not be cached: fall back to a
		// per-call key so the aggregation always runs.
		return NewID("stats-uncacheable")
	}
	return string(raw)
}

// ExportCSVStream streams the visible file list as UTF-8-BOM CSV with formula
// injection neutralised (SPEC §3.10, §9.3). Rows are emitted one at a time so
// the whole result set never sits in memory (READ-06); the row count is
// returned for the export audit event written by the transport layer.
func (s *Service) ExportCSVStream(ctx context.Context, u domain.User, filter SearchFilter, emit func([]string) error) (int, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	groups, err := tx.WorkgroupsOf(ctx, u.ID)
	if err != nil {
		return 0, err
	}
	rows := 0
	streamErr := tx.ExportFilesStream(ctx, statsQuery(u, groups, filter), func(row ports.ExportRow) error {
		fields := []string{
			row.Name,
			row.Path,
			intToString(row.SizeBytes),
			row.UploaderName,
			row.UpdatedAt.UTC().Format(time.RFC3339),
			extensionOf(row.Name),
			intToString(int64(row.VersionSeq)),
		}
		for i := range fields {
			fields[i] = neutralizeCSV(fields[i])
		}
		if werr := emit(fields); werr != nil {
			return werr
		}
		rows++
		return nil
	})
	if streamErr != nil {
		return rows, mapError(streamErr)
	}
	audit(ctx, tx, u, "files.export", "file", "", "success", map[string]any{"rows": rows})
	if err = tx.Commit(ctx); err != nil {
		return rows, err
	}
	return rows, nil
}

// RecordExportFailure audits a streamed export that broke mid-transfer: the
// status line is already committed, so the failure is only visible in the
// audit trail (SPEC §2.6 requires failed operations to be traceable).
func (s *Service) RecordExportFailure(ctx context.Context, u domain.User, rows int, cause error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	reason := ""
	if cause != nil {
		reason = cause.Error()
	}
	audit(ctx, tx, u, "files.export", "file", "", "failed", map[string]any{"rows": rows, "reason": reason})
	_ = tx.Commit(ctx)
}

// neutralizeCSV blocks spreadsheet formula injection without altering content.
func neutralizeCSV(v string) string {
	if strings.HasPrefix(v, "=") || strings.HasPrefix(v, "+") || strings.HasPrefix(v, "-") || strings.HasPrefix(v, "@") {
		return "'" + v
	}
	return v
}

func intToString(v int64) string {
	if v == 0 {
		return "0"
	}
	negative := v < 0
	if negative {
		v = -v
	}
	var digits []byte
	for v > 0 {
		digits = append([]byte{byte('0' + v%10)}, digits...)
		v /= 10
	}
	if negative {
		return "-" + string(digits)
	}
	return string(digits)
}

var _ = errors.Is
