package application

import (
	"context"
	"filesmanage/internal/domain"
	"path/filepath"
	"strings"
)

type fileLineageReader interface {
	FileLineageParent(context.Context, string) (*domain.FileLineage, error)
	FileLineageChildren(context.Context, string) ([]domain.FileLineage, error)
}

// Return only relatives visible to the caller; lineage is not an ACL bypass.
func (s *Service) Lineage(ctx context.Context, u domain.User, id string) (*domain.FileLineage, []domain.FileLineage, error) {
	return s.lineageForAction(ctx, u, id, domain.ActionPreview)
}

// File metadata remains readable with list permission, while every source
// or descendant link itself still requires a separate preview permission.
func (s *Service) LineageForMetadata(ctx context.Context, u domain.User, id string) (*domain.FileLineage, []domain.FileLineage, error) {
	return s.lineageForAction(ctx, u, id, domain.ActionList)
}

func (s *Service) lineageForAction(ctx context.Context, u domain.User, id string, action domain.Action) (*domain.FileLineage, []domain.FileLineage, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = s.visibleFile(ctx, tx, u, id, action); err != nil {
		return nil, nil, err
	}
	store, ok := tx.(fileLineageReader)
	if !ok {
		return nil, []domain.FileLineage{}, nil
	}
	parent, err := store.FileLineageParent(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	if parent != nil {
		source, visibleErr := s.visibleFile(ctx, tx, u, parent.SourceFileID, domain.ActionPreview)
		if visibleErr != nil {
			parent = nil
		} else {
			parent.ID = source.ID
			parent.Name = source.Name
			parent.VersionSeq = currentSeq(source)
			parent.Ext = strings.TrimPrefix(strings.ToLower(filepath.Ext(source.Name)), ".")
		}
	}
	children, err := store.FileLineageChildren(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	visible := make([]domain.FileLineage, 0, len(children))
	for _, child := range children {
		f, accessErr := s.visibleFile(ctx, tx, u, child.ID, domain.ActionPreview)
		if accessErr != nil {
			continue
		}
		child.Name = f.Name
		child.VersionSeq = currentSeq(f)
		child.Ext = strings.TrimPrefix(strings.ToLower(filepath.Ext(f.Name)), ".")
		visible = append(visible, child)
	}
	return parent, visible, nil
}
