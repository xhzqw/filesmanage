package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"unicode/utf8"
)

type CDWQMSFormalFollowupInput struct {
	Reason string `json:"reason"`
}

func (s *Service) CDWQMSFormalNoticeLedger(ctx context.Context, actor domain.User) ([]ports.CDWQMSFormalNotice, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWQMSG16Store)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	items, err := store.CDWQMSFormalNoticeLedger(ctx, actor.ID, 100)
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
func (s *Service) CDWQMSFormalFollowup(ctx context.Context, actor domain.User, noticeID string,
	input CDWQMSFormalFollowupInput, key string) (ports.CDWQMSFormalFollowup, error) {
	var empty ports.CDWQMSFormalFollowup
	input.Reason = strings.TrimSpace(input.Reason)
	if noticeID == "" || !utf8.ValidString(input.Reason) ||
		utf8.RuneCountInString(input.Reason) < 16 || utf8.RuneCountInString(input.Reason) > 2000 {
		return empty, domain.ErrInvalidInput
	}
	raw, err := s.cdwFormalMutate(ctx, actor, "qms.formal.notice.followup", key,
		cdwCommandHash("qms.formal.notice.followup", noticeID, input), noticeID, 200,
		func(tx ports.Tx, _ ports.CDWFormalStore) (any, error) {
			store, ok := tx.(ports.CDWQMSG16Store)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			fileID, e := store.CDWQMSFormalNoticeFile(ctx, noticeID)
			if e != nil {
				return nil, e
			}
			if _, e = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			// The SQL insert trigger enforces current document control authorization.
			return store.CDWQMSFormalFollowup(ctx, NewID("cdwqmsfollowup"), noticeID, actor.ID, input.Reason)
		})
	if err != nil {
		return empty, err
	}
	err = json.Unmarshal(raw, &empty)
	return empty, err
}
