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
	if u.IsAdmin {
		return allActions(), nil
	}
	grants, err := repo.EffectiveGrants(ctx, u.ID, folderID)
	if err != nil {
		return nil, err
	}
	groups, err := repo.WorkgroupsOf(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	direct := make([]domain.ACL, 0, len(grants))
	inherited := make([]domain.ACL, 0, len(grants))
	for _, g := range grants {
		if g.Depth == 0 {
			direct = append(direct, g.Grant)
		} else {
			inherited = append(inherited, g.Grant)
		}
	}
	now := s.now()
	actions := domain.ActionsFor(direct, u.ID, groups, true, now)
	for action := range domain.ActionsFor(inherited, u.ID, groups, false, now) {
		actions[action] = true
	}
	shares, shareErr := repo.FolderSharesForSubject(ctx, u.ID, groups, folderID)
	if shareErr != nil {
		return nil, shareErr
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
	}
	return actions, nil
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
