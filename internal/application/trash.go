package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

// Trash use cases implement the §7.6 soft-delete state machine. Restoring a
// folder trash entry revives its whole captured subtree; name collisions are
// reported instead of silently overwriting.

func (s *Service) ListTrash(ctx context.Context, u domain.User) ([]domain.TrashEntry, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	return tx.ListTrashEntries(ctx, u.ID)
}

type RestoreRequest struct {
	DestinationFolderID string
	NewName             string
}

// RestoreFromTrash revives a trashed file or folder subtree. Files restore
// under their original parent unless a destination is supplied; a missing
// original parent without destination is E_PARENT_MISSING, and a live name
// collision is E_NAME_CONFLICT.
func (s *Service) RestoreFromTrash(ctx context.Context, u domain.User, entryID string, req RestoreRequest) (domain.TrashEntry, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.TrashEntry{}, err
	}
	defer tx.Rollback(ctx)
	entry, err := tx.TrashEntryByID(ctx, entryID)
	if err != nil {
		return domain.TrashEntry{}, domain.ErrNotFound
	}
	if entry.RestoredAt != nil || entry.PurgedAt != nil {
		return domain.TrashEntry{}, domain.ErrNotFound
	}
	if entry.FileID != nil {
		if err = s.restoreFileFromTrash(ctx, tx, u, entry, req); err != nil {
			return domain.TrashEntry{}, err
		}
	} else if entry.FolderID != nil {
		if err = s.restoreFolderFromTrash(ctx, tx, u, entry, req); err != nil {
			return domain.TrashEntry{}, err
		}
	} else {
		return domain.TrashEntry{}, domain.ErrNotFound
	}
	if err = tx.MarkTrashRestored(ctx, entry.ID); err != nil {
		return domain.TrashEntry{}, err
	}
	audit(ctx, tx, u, "trash.restore", "trash", entry.ID, "success",
		map[string]any{"oldName": entry.OldName, "destination": req.DestinationFolderID, "newName": req.NewName})
	if err = tx.Commit(ctx); err != nil {
		return domain.TrashEntry{}, err
	}
	return entry, nil
}

func (s *Service) restoreFileFromTrash(ctx context.Context, tx ports.Repository, u domain.User, entry domain.TrashEntry, req RestoreRequest) error {
	file, err := tx.FileByID(ctx, *entry.FileID)
	if err != nil {
		return domain.ErrNotFound
	}
	parentID := ""
	if entry.OldParentID != nil {
		parentID = *entry.OldParentID
	}
	if req.DestinationFolderID != "" {
		parentID = req.DestinationFolderID
	}
	parent, err := s.activeFolder(ctx, tx, parentID)
	if err != nil {
		return domain.ErrParentMissing
	}
	if err = s.require(ctx, tx, u, parent.ID, domain.ActionUpload); err != nil {
		return err
	}
	if req.NewName != "" {
		if err = s.renameFileForRestore(ctx, tx, file.ID, req.NewName); err != nil {
			return err
		}
	}
	if err = tx.RestoreFile(ctx, file.ID); err != nil {
		return mapError(err)
	}
	return nil
}

func (s *Service) restoreFolderFromTrash(ctx context.Context, tx ports.Repository, u domain.User, entry domain.TrashEntry, req RestoreRequest) error {
	subtree, err := tx.FolderSubtreeIncludingDeleted(ctx, *entry.FolderID)
	if err != nil {
		return err
	}
	if len(subtree) == 0 {
		return domain.ErrNotFound
	}
	root := subtree[0]
	parentID := ""
	if root.ParentID != nil {
		parentID = *root.ParentID
	}
	if req.DestinationFolderID != "" {
		parentID = req.DestinationFolderID
	}
	parent, err := s.activeFolder(ctx, tx, parentID)
	if err != nil {
		return domain.ErrParentMissing
	}
	if err = s.require(ctx, tx, u, parent.ID, domain.ActionUpload); err != nil {
		return err
	}
	if req.NewName != "" && req.NewName != root.Name {
		if err = tx.RenameFolder(ctx, root.ID, req.NewName); err != nil {
			return mapError(err)
		}
	}
	ids := make([]string, 0, len(subtree))
	for _, folder := range subtree {
		if err = tx.RestoreFolder(ctx, folder.ID); err != nil {
			return mapError(err)
		}
		ids = append(ids, folder.ID)
	}
	return tx.RestoreFilesUnderFolders(ctx, ids)
}

func (s *Service) renameFileForRestore(ctx context.Context, tx ports.Repository, fileID, name string) error {
	if err := validateFileName(name); err != nil {
		return err
	}
	return tx.RenameFile(ctx, fileID, name)
}

// Purge marks a trash entry permanently deleted. Only admins may purge in this
// slice; blob reclamation is a later GC job and never runs inline.
func (s *Service) PurgeTrashEntry(ctx context.Context, u domain.User, entryID string) error {
	if !u.IsAdmin {
		return domain.ErrForbidden
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	entry, err := tx.TrashEntryByID(ctx, entryID)
	if err != nil {
		return domain.ErrNotFound
	}
	if entry.PurgedAt != nil {
		return domain.ErrNotFound
	}
	if err = tx.MarkTrashPurged(ctx, entry.ID); err != nil {
		return err
	}
	audit(ctx, tx, u, "trash.purge", "trash", entry.ID, "success", map[string]any{"oldName": entry.OldName})
	return tx.Commit(ctx)
}

func validateFileName(name string) error {
	if len(name) == 0 || len(name) > 200 {
		return domain.ErrInvalidInput
	}
	return nil
}

var _ = errors.Is
