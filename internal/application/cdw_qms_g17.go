package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

func (s *Service) CDWQMSFormalLineage(ctx context.Context, actor domain.User, id string) (ports.CDWQMSFormalLineage, error) {
	var empty ports.CDWQMSFormalLineage
	if id == "" {
		return empty, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return empty, err
	}
	defer tx.Rollback(ctx)
	g17, ok := tx.(ports.CDWQMSG16Store)
	if !ok {
		return empty, domain.ErrInvalidInput
	}
	formal, ok := tx.(ports.CDWFormalStore)
	if !ok {
		return empty, domain.ErrInvalidInput
	}
	fileID, err := formal.CDWFormalApprovalFile(ctx, id)
	if err != nil {
		return empty, err
	}
	allowed, err := g17.CDWQMSFormalLineageCanRead(ctx, id, actor.ID)
	if err != nil {
		return empty, err
	}
	if !allowed {
		return empty, domain.ErrForbidden
	}
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return empty, err
	}
	chain, err := g17.CDWQMSFormalLineage(ctx, id)
	if err != nil {
		return empty, err
	}
	// Every link is same-file by DB contract; enforce ACL for all nodes again
	// even when the requested node was authorized at the beginning.
	for _, node := range chain.Nodes {
		if _, e := s.visibleFile(ctx, tx, actor, node.FileID, domain.ActionPreview); e != nil {
			return empty, e
		}
	}
	return chain, nil
}
