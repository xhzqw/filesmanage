package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

// resolveActions computes the effective action set for a user on a folder,
// unioning direct grants with inherited ancestor grants. Admin holds every
// action; everyone else is default-deny.
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
