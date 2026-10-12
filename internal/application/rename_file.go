package application

import (
	"context"
	"filesmanage/internal/domain"
)

// RenameFile renames an active file inside its folder. Renaming requires the
// rename action on the containing folder and must not collide with a live name.
func (s *Service) RenameFile(ctx context.Context, u domain.User, fileID, name string) (domain.File, error) {
	if len(name) == 0 || len(name) > 200 {
		return domain.File{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.File{}, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionRename)
	if err != nil {
		return domain.File{}, err
	}
	if _, err = tx.FileByNameInFolder(ctx, file.FolderID, name); err == nil {
		return domain.File{}, domain.ErrNameConflict
	} else if !isRowMissing(err) {
		return domain.File{}, err
	}
	if err = tx.RenameFile(ctx, file.ID, name); err != nil {
		return domain.File{}, mapError(err)
	}
	file.Name = name
	audit(ctx, tx, u, "file.rename", "file", file.ID, "success", map[string]any{"name": name})
	if err = tx.Commit(ctx); err != nil {
		return domain.File{}, err
	}
	s.notifyWorkspaceChange("file", "search")
	return file, nil
}
