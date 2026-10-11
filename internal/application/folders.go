package application

import (
	"context"
	"filesmanage/internal/domain"
)

// Folder use cases. Creating a subfolder requires upload on the parent;
// renaming requires rename on the folder itself; moving requires move on the
// source and upload on the destination; deleting requires delete.

type FolderResult struct {
	Folder domain.Folder
}

func (s *Service) CreateFolder(ctx context.Context, u domain.User, parentID, name string) (domain.Folder, error) {
	if len(name) == 0 || len(name) > 200 {
		return domain.Folder{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.Folder{}, err
	}
	defer tx.Rollback(ctx)
	parent, err := s.activeFolder(ctx, tx, parentID)
	if err != nil {
		return domain.Folder{}, err
	}
	if err = s.require(ctx, tx, u, parent.ID, domain.ActionUpload); err != nil {
		return domain.Folder{}, err
	}
	folder := domain.Folder{ID: NewID("folder"), Name: name, ParentID: &parent.ID, OwnerID: u.ID}
	if err = tx.CreateFolder(ctx, folder); err != nil {
		return domain.Folder{}, mapError(err)
	}
	audit(ctx, tx, u, "folder.create", "folder", folder.ID, "success", map[string]any{"name": name, "parentId": parent.ID})
	if err = tx.Commit(ctx); err != nil {
		return domain.Folder{}, err
	}
	return folder, nil
}

func (s *Service) RenameFolder(ctx context.Context, u domain.User, folderID, name string) (domain.Folder, error) {
	if len(name) == 0 || len(name) > 200 {
		return domain.Folder{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.Folder{}, err
	}
	defer tx.Rollback(ctx)
	folder, err := s.activeFolder(ctx, tx, folderID)
	if err != nil {
		return domain.Folder{}, err
	}
	if err = s.require(ctx, tx, u, folder.ID, domain.ActionRename); err != nil {
		return domain.Folder{}, err
	}
	if err = tx.RenameFolder(ctx, folder.ID, name); err != nil {
		return domain.Folder{}, mapError(err)
	}
	folder.Name = name
	audit(ctx, tx, u, "folder.rename", "folder", folder.ID, "success", map[string]any{"name": name})
	if err = tx.Commit(ctx); err != nil {
		return domain.Folder{}, err
	}
	return folder, nil
}

func (s *Service) MoveFolder(ctx context.Context, u domain.User, folderID, targetParentID string) (domain.Folder, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.Folder{}, err
	}
	defer tx.Rollback(ctx)
	folder, err := s.activeFolder(ctx, tx, folderID)
	if err != nil {
		return domain.Folder{}, err
	}
	target, err := s.activeFolder(ctx, tx, targetParentID)
	if err != nil {
		return domain.Folder{}, err
	}
	if folder.ID == target.ID {
		return domain.Folder{}, domain.ErrInvalidInput
	}
	if err = s.require(ctx, tx, u, folder.ID, domain.ActionMove); err != nil {
		return domain.Folder{}, err
	}
	if err = s.require(ctx, tx, u, target.ID, domain.ActionUpload); err != nil {
		return domain.Folder{}, err
	}
	if err = tx.MoveFolder(ctx, folder.ID, &target.ID); err != nil {
		return domain.Folder{}, mapError(err)
	}
	folder.ParentID = &target.ID
	audit(ctx, tx, u, "folder.move", "folder", folder.ID, "success", map[string]any{"targetId": target.ID})
	if err = tx.Commit(ctx); err != nil {
		return domain.Folder{}, err
	}
	// Authorisation just changed: drop every cached read so the next
	// request sees the new scope (PE04).
	s.bumpACLEpoch()

	return folder, nil
}

// DeleteFolder soft-deletes the whole active subtree and records exactly one
// top-level trash entry so a later restore cannot double-apply.
func (s *Service) DeleteFolder(ctx context.Context, u domain.User, folderID string) (domain.TrashEntry, int, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.TrashEntry{}, 0, err
	}
	defer tx.Rollback(ctx)
	folder, err := s.activeFolder(ctx, tx, folderID)
	if err != nil {
		return domain.TrashEntry{}, 0, err
	}
	if err = s.require(ctx, tx, u, folder.ID, domain.ActionDelete); err != nil {
		return domain.TrashEntry{}, 0, err
	}
	var originalTrail []domain.TrashPathPart
	if folder.ParentID != nil {
		originalTrail, err = snapshotTrashPath(ctx, tx, *folder.ParentID)
		if err != nil {
			return domain.TrashEntry{}, 0, err
		}
	}
	subtree, err := tx.FolderSubtree(ctx, folder.ID)
	if err != nil {
		return domain.TrashEntry{}, 0, err
	}
	ids := folderIDs(subtree)
	if protected, e := tx.HasProtectedLifecycleInFolders(ctx, ids, s.now()); e != nil {
		return domain.TrashEntry{}, 0, e
	} else if protected {
		return domain.TrashEntry{}, 0, domain.ErrConflict
	}
	for _, member := range subtree {
		if err = tx.SoftDeleteFolder(ctx, member.ID); err != nil {
			return domain.TrashEntry{}, 0, err
		}
	}
	fileCount, err := tx.CountFilesInFolders(ctx, ids)
	if err != nil {
		return domain.TrashEntry{}, 0, err
	}
	if err = tx.SoftDeleteFilesUnderFolders(ctx, folderIDs(subtree)); err != nil {
		return domain.TrashEntry{}, 0, err
	}
	entry := domain.TrashEntry{
		ID: NewID("trash"), FolderID: &folder.ID, OldParentID: folder.ParentID, OldParentTrail: originalTrail,
		OldName: folder.Name, DeletedBy: u.ID, DeletedAt: s.now(), SubtreeCount: len(subtree),
	}
	if err = tx.InsertTrashEntry(ctx, entry); err != nil {
		return domain.TrashEntry{}, 0, err
	}
	audit(ctx, tx, u, "folder.delete", "folder", folder.ID, "success",
		map[string]any{"trashId": entry.ID, "folders": len(subtree), "files": fileCount})
	if err = tx.Commit(ctx); err != nil {
		return domain.TrashEntry{}, 0, err
	}
	return entry, len(subtree), nil
}

func folderIDs(folders []domain.Folder) []string {
	out := make([]string, 0, len(folders))
	for _, f := range folders {
		out = append(out, f.ID)
	}
	return out
}
