package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"unicode/utf8"
)

type CDWDocumentClassInput struct {
	ApprovalClass string `json:"approvalClass"`
	Reason        string `json:"reason"`
}

func (s *Service) CDWDocumentClass(ctx context.Context, actor domain.User, fileID string) (ports.CDWDocumentClassification, error) {
	var result ports.CDWDocumentClassification
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return result, err
	}
	store, ok := tx.(ports.CDWFormalStore)
	if !ok {
		return result, domain.ErrInvalidInput
	}
	return store.CDWFormalClass(ctx, fileID)
}

func (s *Service) CDWClassifyDocument(ctx context.Context, actor domain.User, fileID string, input CDWDocumentClassInput, key string) (ports.CDWDocumentClassification, error) {
	var result ports.CDWDocumentClassification
	input.Reason = strings.TrimSpace(input.Reason)
	if fileID == "" || (input.ApprovalClass != "qms" && input.ApprovalClass != "general") ||
		utf8.RuneCountInString(input.Reason) < 16 || utf8.RuneCountInString(input.Reason) > 1000 {
		return result, domain.ErrInvalidInput
	}
	raw, err := s.cdwFormalMutate(ctx, actor, "formal.document.classify", key,
		cdwCommandHash("formal.document.classify", fileID, input), fileID, 201,
		func(tx ports.Tx, store ports.CDWFormalStore) (any, error) {
			if _, e := s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			return store.CDWFormalClassify(ctx, fileID, input.ApprovalClass, input.Reason, actor.ID)
		})
	if err != nil {
		return result, err
	}
	err = json.Unmarshal(raw, &result)
	return result, err
}
