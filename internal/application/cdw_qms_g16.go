package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"unicode/utf8"
)

type CDWQMSLegacyHoldInput struct {
	Reason string `json:"reason"`
}

func (s *Service) CDWQMSLegacyAnomalies(ctx context.Context, actor domain.User) ([]ports.CDWQMSLegacyAnomaly, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWQMSG16Store)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	items, err := store.CDWQMSLegacyAnomalies(ctx, actor.ID, 100)
	if err != nil {
		return nil, err
	}
	out := []ports.CDWQMSLegacyAnomaly{}
	for _, item := range items {
		if _, e := s.visibleFile(ctx, tx, actor, item.FileID, domain.ActionPreview); e == nil {
			out = append(out, item)
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	return out, nil
}
func (s *Service) CDWQMSHoldLegacy(ctx context.Context, actor domain.User, id string, input CDWQMSLegacyHoldInput, key string) (ports.CDWQMSLegacyHold, error) {
	var out ports.CDWQMSLegacyHold
	input.Reason = strings.TrimSpace(input.Reason)
	if id == "" || !utf8.ValidString(input.Reason) || utf8.RuneCountInString(input.Reason) < 16 ||
		utf8.RuneCountInString(input.Reason) > 2000 {
		return out, domain.ErrInvalidInput
	}
	newID := NewID("cdwqmshold")
	raw, err := s.cdwFormalMutate(ctx, actor, "qms.legacy.hold", key,
		cdwCommandHash("qms.legacy.hold", id, input), id, 200,
		func(tx ports.Tx, _ ports.CDWFormalStore) (any, error) {
			store, ok := tx.(ports.CDWQMSG16Store)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			formal, ok := tx.(ports.CDWFormalStore)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			fid, e := formal.CDWFormalApprovalFile(ctx, id)
			if e != nil {
				return nil, e
			}
			if _, e = s.visibleFile(ctx, tx, actor, fid, domain.ActionPreview); e != nil {
				return nil, e
			}
			return store.CDWQMSHoldLegacy(ctx, newID, id, actor.ID, input.Reason)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}
func (s *Service) CDWQMSFormalNotices(ctx context.Context, actor domain.User) ([]ports.CDWQMSFormalNotice, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWQMSG16Store)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	items, err := store.CDWQMSFormalNotices(ctx, actor.ID, 100)
	if err != nil {
		return nil, err
	}
	out := []ports.CDWQMSFormalNotice{}
	for _, item := range items {
		if _, e := s.visibleFile(ctx, tx, actor, item.FileID, domain.ActionPreview); e == nil {
			out = append(out, item)
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	return out, nil
}
func (s *Service) CDWQMSFormalNoticeRead(ctx context.Context, actor domain.User, id, key string) (CDWQMSAlertReceipt, error) {
	var out CDWQMSAlertReceipt
	if id == "" {
		return out, domain.ErrInvalidInput
	}
	raw, err := s.cdwFormalMutate(ctx, actor, "qms.formal.notice.read", key,
		cdwCommandHash("qms.formal.notice.read", id, id), id, 200,
		func(tx ports.Tx, _ ports.CDWFormalStore) (any, error) {
			store, ok := tx.(ports.CDWQMSG16Store)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			// Explicit recipient identity checked by DB UPDATE; nonexistent/other
			// recipients reveal no record.
			changed, e := store.CDWQMSReadFormalNotice(ctx, id, actor.ID)
			if e != nil {
				return nil, e
			}
			if !changed {
				return nil, domain.ErrNotFound
			}
			return CDWQMSAlertReceipt{ID: id, Read: true}, nil
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}
