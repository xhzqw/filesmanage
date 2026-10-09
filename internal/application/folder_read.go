package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
)

// Paged folder reads backing the FolderPicker (COMPLEX-WORKFLOWS §2.3 /
// ADR-UX-07): GET /api/folders/children and GET /api/folders/search. Both are
// read-only, keyset-paginated and answer only folders the caller may list, so
// GET /api/folders/tree keeps serving whole small trees unchanged.

// FolderPageItem is one row of either paged read.
//   - canSelect is a UI hint only: the caller holds upload on the folder, so the
//     transaction that consumes a selection re-verifies the permission.
//   - disabledReason is a short public reason that never explains visibility, so
//     probing cannot tell a hidden folder from a read-only one.
//   - path is filled by search only: the " / "-joined names of the listable
//     ancestors, truncated at the first ancestor the caller may not list. An
//     orphaned subtree therefore renders as a root with its own name.
type FolderPageItem struct {
	ID             string
	Name           string
	ParentID       *string
	HasChildren    bool
	CanSelect      bool
	DisabledReason string
	Path           string
}

// FolderPage is one page plus the cursor for the next one; NextCursor is empty
// on the last page.
type FolderPage struct {
	Items      []FolderPageItem
	NextCursor string
}

// FolderCursor carries the sort key (name, id) of the last row of the previous
// page.
type FolderCursor struct {
	Name string
	ID   string
}

// folderPageDefault is the page size when the client sends no limit, matching
// the file list.
const folderPageDefault = 50

// disabledReasonUpload is the only disabledReason these reads publish.
const disabledReasonUpload = "没有上传权限"

// FolderChildren lists one page of the caller's visible children of parentID;
// an empty parentID addresses the visible roots, which include a listable folder
// whose parent the caller may not list.
//
// A parent the caller may not list answers ErrNotFound exactly like a missing
// one, so probing cannot distinguish "hidden" from "absent" (SAFE-04). The read
// writes nothing and takes no lock.
func (s *Service) FolderChildren(ctx context.Context, u domain.User, parentID string, cursor FolderCursor, limit int) (FolderPage, error) {
	limit = clampFolderPageLimit(limit)
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return FolderPage{}, err
	}
	defer tx.Rollback(ctx)
	parent := ""
	if parentID != "" {
		folder, err := s.activeFolder(ctx, tx, parentID)
		if err != nil {
			return FolderPage{}, err
		}
		if err = s.requireListable(ctx, tx, u, folder.ID); err != nil {
			return FolderPage{}, err
		}
		parent = folder.ID
	}
	rows, err := tx.ListVisibleFolderChildren(ctx, ports.FolderChildQuery{
		UserID: u.ID, ParentID: parent, CursorName: cursor.Name, CursorID: cursor.ID, Limit: limit + 1,
	})
	if err != nil {
		return FolderPage{}, err
	}
	return s.buildFolderPage(ctx, tx, u, rows, limit, false)
}

// SearchFolders lists one page of the caller's visible folders whose name
// contains query. Whitespace-only input is invalid rather than "everything".
func (s *Service) SearchFolders(ctx context.Context, u domain.User, query string, cursor FolderCursor, limit int) (FolderPage, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return FolderPage{}, domain.ErrInvalidInput
	}
	limit = clampFolderPageLimit(limit)
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return FolderPage{}, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.SearchVisibleFolders(ctx, ports.FolderSearchQuery{
		UserID: u.ID, Query: query, CursorName: cursor.Name, CursorID: cursor.ID, Limit: limit + 1,
	})
	if err != nil {
		return FolderPage{}, err
	}
	return s.buildFolderPage(ctx, tx, u, rows, limit, true)
}

// clampFolderPageLimit applies the file-list convention: an absent limit means
// the default page, an oversized one is capped by MaxFolderPage.
func clampFolderPageLimit(limit int) int {
	if limit <= 0 {
		return folderPageDefault
	}
	if limit > ports.MaxFolderPage {
		return ports.MaxFolderPage
	}
	return limit
}

// buildFolderPage cuts the lookahead row, encodes the next cursor and resolves
// the per-row read hints. withPath is set by the search read.
func (s *Service) buildFolderPage(ctx context.Context, repo ports.Repository, u domain.User, rows []ports.FolderPageRow, limit int, withPath bool) (FolderPage, error) {
	page := FolderPage{Items: []FolderPageItem{}}
	if len(rows) > limit {
		rows = rows[:limit]
		page.NextCursor = encodeFolderCursor(rows[limit-1].Folder)
	}
	view := newFolderReadView(s, repo, u)
	for _, row := range rows {
		actions, err := view.actions(ctx, row.Folder.ID)
		if err != nil {
			return FolderPage{}, err
		}
		item := FolderPageItem{
			ID: row.Folder.ID, Name: row.Folder.Name, ParentID: row.Folder.ParentID,
			HasChildren: row.HasChildren, CanSelect: actions[domain.ActionUpload],
		}
		if !item.CanSelect {
			item.DisabledReason = disabledReasonUpload
		}
		if withPath {
			item.Path = view.path(ctx, row.Folder.ID)
		}
		page.Items = append(page.Items, item)
	}
	return page, nil
}

// requireListable answers ErrNotFound - never ErrForbidden - when the caller may
// not list the folder, so a hidden folder and a missing id stay
// indistinguishable (SAFE-04).
func (s *Service) requireListable(ctx context.Context, repo ports.Repository, u domain.User, folderID string) error {
	listable, err := s.folderListable(ctx, repo, u, folderID)
	if err != nil {
		return err
	}
	if !listable {
		return domain.ErrNotFound
	}
	return nil
}

// folderReadView is the per-request view of one caller's folder scope. It
// memoises resolveActions for the duration of a single read, so a page resolves
// each ancestor's permissions once instead of once per row; every decision still
// comes from the same authorization helper the write paths use.
type folderReadView struct {
	svc   *Service
	repo  ports.Repository
	user  domain.User
	known map[string]map[domain.Action]bool
}

func newFolderReadView(s *Service, repo ports.Repository, u domain.User) *folderReadView {
	return &folderReadView{svc: s, repo: repo, user: u, known: map[string]map[domain.Action]bool{}}
}

func (v *folderReadView) actions(ctx context.Context, folderID string) (map[domain.Action]bool, error) {
	if cached, ok := v.known[folderID]; ok {
		return cached, nil
	}
	actions, err := v.svc.resolveActions(ctx, v.repo, v.user, folderID)
	if err != nil {
		return nil, err
	}
	v.known[folderID] = actions
	return actions, nil
}

func (v *folderReadView) listable(ctx context.Context, folderID string) (bool, error) {
	actions, err := v.actions(ctx, folderID)
	if err != nil {
		return false, err
	}
	return actions[domain.ActionList], nil
}

// path renders the " / "-joined folder names from the root down to folderID,
// stopping at the first ancestor the caller may not list so a hidden branch
// never leaks its name or the path above it.
func (v *folderReadView) path(ctx context.Context, folderID string) string {
	names := make([]string, 0, 8)
	current := folderID
	for depth := 0; depth <= 64 && current != ""; depth++ {
		folder, err := v.repo.FolderByID(ctx, current)
		if err != nil {
			break
		}
		listable, err := v.listable(ctx, folder.ID)
		if err != nil || !listable {
			break
		}
		names = append(names, folder.Name)
		if folder.ParentID == nil {
			break
		}
		current = *folder.ParentID
	}
	for i, j := 0, len(names)-1; i < j; i, j = i+1, j-1 {
		names[i], names[j] = names[j], names[i]
	}
	return strings.Join(names, " / ")
}
