package application

import (
	"encoding/json"
	"fmt"
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
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

// CreateShare shares a resource the caller can already see. Write actions are
// rejected: shares only carry {list,preview,download}.
func (s *Service) CreateShare(ctx context.Context, u domain.User, draft ShareDraft) (domain.Share, error) {
	if (draft.ResourceKind != "file" && draft.ResourceKind != "folder") || draft.ResourceID == "" {
		return domain.Share{}, domain.ErrInvalidInput
	}
	if len(draft.Actions) == 0 || (draft.RecipientKind != "user" && draft.RecipientKind != "group") {
		return domain.Share{}, domain.ErrInvalidInput
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
		if _, err = s.visibleFile(ctx, tx, u, fileID, domain.ActionPreview); err != nil {
			return domain.Share{}, err
		}
	} else {
		folderID := draft.ResourceID
		share.FolderID = &folderID
		folder, fErr := s.activeFolder(ctx, tx, folderID)
		if fErr != nil {
			return domain.Share{}, fErr
		}
		if err = s.require(ctx, tx, u, folder.ID, domain.ActionList); err != nil {
			return domain.Share{}, err
		}
	}
	if err = tx.CreateShare(ctx, share); err != nil {
		return domain.Share{}, mapError(err)
	}
	audit(ctx, tx, u, "share.create", draft.ResourceKind, draft.ResourceID, "success",
		map[string]any{"shareId": share.ID, "recipientKind": draft.RecipientKind, "recipientId": draft.RecipientID})
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
	audit(ctx, tx, u, "share.revoke", "share", shareID, "success", nil)
	// Authorisation just changed: drop every cached read so the next
	// request sees the new scope (PE04).
	s.bumpACLEpoch()

	return tx.Commit(ctx)
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

// ---------- favorites ----------

func (s *Service) ListFavorites(ctx context.Context, u domain.User) ([]domain.Favorite, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	return tx.ListFavorites(ctx, u.ID)
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
	// The resource must be visible to the caller before it can be favorited.
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
	Uploader          string
	MimePrefix        string
	From              *time.Time
	To                *time.Time
	Sort              string
	Limit             int
}

func (s *Service) Search(ctx context.Context, u domain.User, filter SearchFilter) ([]domain.File, int, error) {
	if filter.Limit <= 0 {
		filter.Limit = 50
	}
	if filter.Limit > 200 {
		filter.Limit = 200
	}
	// Repeated identical queries are memoised for a short TTL. The key carries
	// the principal and the whole filter, so a cached page is only ever served
	// to the same user with the same scope; the TTL bounds how long a newly
	// uploaded file can be missing from results.
	// The epoch invalidates every cached read the moment authorisation
	// changes, so a revocation or a new grant is visible on the next request
	// (PE04) instead of after the TTL.
	key := fmt.Sprintf("%d|%s", s.epoch(), searchCacheKey(u, filter))
	if cached, ok := s.search.get(key, s.now()); ok {
		return cached.files, cached.total, nil
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, 0, err
	}
	defer tx.Rollback(ctx)
	groups, err := tx.WorkgroupsOf(ctx, u.ID)
	if err != nil {
		return nil, 0, err
	}
	files, total, err := tx.SearchFiles(ctx, searchQuery(u, groups, filter))
	if err != nil {
		return nil, 0, err
	}
	s.search.put(key, searchEntryValue{files: files, total: total}, s.now())
	return files, total, nil
}

// searchCacheKey binds the caller's identity, admin flag and the whole filter
// (query, folder, descendant flag, uploader, mime prefix, time range, sort and
// limit), so no two users or two scopes can share a cached page.
func searchCacheKey(u domain.User, filter SearchFilter) string {
	raw, err := json.Marshal(struct {
		UserID            string
		Admin             bool
		Query             string
		FolderID          string
		IncludeDescendant bool
		Uploader          string
		MimePrefix        string
		From              *time.Time
		To                *time.Time
		Sort              string
		Limit             int
	}{u.ID, u.IsAdmin, filter.Query, filter.FolderID, filter.IncludeDescendant,
		filter.Uploader, filter.MimePrefix, filter.From, filter.To, filter.Sort, filter.Limit})
	if err != nil {
		return NewID("search-uncacheable")
	}
	return string(raw)
}

func searchQuery(u domain.User, groups []string, filter SearchFilter) ports.FileSearchQuery {
	return ports.FileSearchQuery{
		UserID: u.ID, GroupIDs: groups, FolderID: filter.FolderID,
		IncludeDescendant: filter.IncludeDescendant, Query: filter.Query,
		// The tsvector index is built from the CJK-spaced text; the query is
		// spaced the same way so phraseto_tsquery keeps adjacency (SPEC §10.2).
		TextQuery: SpaceCJK(filter.Query),
		Uploader:  filter.Uploader, MimePrefix: filter.MimePrefix,
		From: filter.From, To: filter.To, Sort: filter.Sort, Limit: filter.Limit,
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
		UserID             string
		Admin              bool
		FolderID           string
		IncludeDescendant  bool
		Uploader           string
		MimePrefix         string
		From               *time.Time
		To                 *time.Time
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
