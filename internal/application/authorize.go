package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

// resolveActions computes the effective action set for a user on a folder,
// unioning direct grants with inherited ancestor grants. Admin holds every
// action; everyone else is default-deny.
//
// Shares are part of the same resolution (SPEC §2.4): a folder share applies on
// the shared folder and, when include_descendants is set, on its subtree. The
// search/stats/export scope CTE uses the same rule, so the document page and
// the search page can never disagree about what a share grants.
func (s *Service) resolveActions(ctx context.Context, repo ports.Repository, u domain.User, folderID string) (map[domain.Action]bool, error) {
	actions, _, err := s.resolveActionsWithSources(ctx, repo, u, folderID, false)
	return actions, err
}

// resolveActionsWithSources is the single authorization decision path. The
// optional explanation is assembled from the same checked grants and shares:
// no independent UI or reporting algorithm can accidentally grant more.
func (s *Service) resolveActionsWithSources(ctx context.Context, repo ports.Repository, u domain.User, folderID string, explain bool) (map[domain.Action]bool, []PermissionSource, error) {
	if u.IsAdmin {
		if explain {
			return allActions(), []PermissionSource{{Kind: "admin_override", ResourceID: folderID, Actions: orderedActions(allActions())}}, nil
		}
		return allActions(), nil, nil
	}
	grants, err := repo.EffectiveGrants(ctx, u.ID, folderID)
	if err != nil {
		return nil, nil, err
	}
	groups, err := repo.WorkgroupsOf(ctx, u.ID)
	if err != nil {
		return nil, nil, err
	}
	direct := make([]domain.ACL, 0, len(grants))
	inherited := make([]domain.ACL, 0, len(grants))
	sources := make([]PermissionSource, 0)
	now := s.now()
	for _, g := range grants {
		if g.Depth == 0 {
			direct = append(direct, g.Grant)
		} else {
			inherited = append(inherited, g.Grant)
		}
		if !explain || (g.Depth > 0 && g.Grant.ScopeOnly) ||
			(g.Grant.ExpiresAt != nil && !g.Grant.ExpiresAt.After(now)) {
			continue
		}
		if g.Grant.SubjectKind == "user" && g.Grant.SubjectID != u.ID {
			continue
		}
		if g.Grant.SubjectKind == "group" && !containsGroup(groups, g.Grant.SubjectID) {
			continue
		}
		sourceActions := make([]domain.Action, 0, len(g.Grant.Actions))
		for _, action := range g.Grant.Actions {
			if domain.AllowedAction(action) {
				sourceActions = append(sourceActions, action)
			}
		}
		if len(sourceActions) == 0 {
			continue
		}
		kind := "direct_acl"
		if g.Depth > 0 {
			kind = "inherited_acl"
		}
		if g.Grant.SubjectKind == "group" {
			kind = "workgroup_acl"
		}
		sources = append(sources, PermissionSource{
			Kind: kind, ResourceID: g.Grant.FolderID, GrantID: g.Grant.ID,
			SubjectKind: g.Grant.SubjectKind, SubjectID: g.Grant.SubjectID,
			Actions: sourceActions, ScopeOnly: g.Grant.ScopeOnly, Depth: g.Depth,
			ExpiresAt: g.Grant.ExpiresAt,
		})
	}
	actions := domain.ActionsFor(direct, u.ID, groups, true, now)
	for action := range domain.ActionsFor(inherited, u.ID, groups, false, now) {
		actions[action] = true
	}
	shares, shareErr := repo.FolderSharesForSubject(ctx, u.ID, groups, folderID)
	if shareErr != nil {
		return nil, nil, shareErr
	}
	for _, share := range shares {
		if share.RevokedAt != nil {
			continue
		}
		if share.ExpiresAt != nil && !share.ExpiresAt.After(now) {
			continue
		}
		for _, action := range share.Actions {
			actions[action] = true
		}
		if explain && share.FolderID != nil {
			sources = append(sources, PermissionSource{
				Kind: "folder_share", ResourceID: *share.FolderID, GrantID: share.ID,
				SubjectKind: share.RecipientKind, SubjectID: share.RecipientID,
				// The explanation sorts actions; never mutate the backing share
				// slice returned from a repository or shared with other readers.
				Actions: append([]domain.Action(nil), share.Actions...), ExpiresAt: share.ExpiresAt,
				ScopeOnly: !share.IncludeDescendants,
			})
		}
	}
	return actions, sources, nil
}

func (s *Service) require(ctx context.Context, repo ports.Repository, u domain.User, folderID string, action domain.Action) error {
	actions, err := s.resolveActions(ctx, repo, u, folderID)
	if err != nil {
		return err
	}
	if !actions[action] {
		return domain.ErrForbidden
	}
	return nil
}

// fileShareGrants reports whether an active file-level share gives the user the
// requested action on the file (SPEC §2.4). Shares only carry passive actions,
// so this can never escalate to modify/delete/manage.
func (s *Service) fileShareGrants(ctx context.Context, repo ports.Repository, u domain.User, fileID string, action domain.Action) (bool, error) {
	groups, err := repo.WorkgroupsOf(ctx, u.ID)
	if err != nil {
		return false, err
	}
	shares, err := repo.FileSharesForSubject(ctx, u.ID, groups, fileID)
	if err != nil {
		return false, err
	}
	now := s.now()
	for _, share := range shares {
		if share.RevokedAt != nil {
			continue
		}
		if share.ExpiresAt != nil && !share.ExpiresAt.After(now) {
			continue
		}
		for _, granted := range share.Actions {
			if granted == action {
				return true, nil
			}
		}
	}
	return false, nil
}

// activeFolder loads a folder and rejects soft-deleted ones so trashed trees
// stay invisible even when their id is known.
func (s *Service) activeFolder(ctx context.Context, repo ports.Repository, id string) (domain.Folder, error) {
	f, err := repo.FolderByID(ctx, id)
	if err != nil {
		return domain.Folder{}, domain.ErrNotFound
	}
	if f.DeletedAt != nil {
		return domain.Folder{}, domain.ErrNotFound
	}
	return f, nil
}
