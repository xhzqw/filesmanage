package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"io"
	"strings"
	"unicode/utf8"
)

type CDWReadingConfirmationInput struct {
	Statement string `json:"statement"`
}

func (s *Service) CDWReadingInbox(ctx context.Context, actor domain.User, limit int) ([]ports.CDWReadingAssignment, error) {
	if limit < 1 || limit > 100 {
		return nil, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWReadingStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	items, err := store.CDWReadingInbox(ctx, actor.ID, limit*3)
	if err != nil {
		return nil, err
	}
	result := []ports.CDWReadingAssignment{}
	for _, item := range items {
		if _, e := s.visibleFile(ctx, tx, actor, item.FileID, domain.ActionPreview); e == nil {
			result = append(result, item)
			if len(result) >= limit {
				break
			}
		}
	}
	return result, nil
}
func (s *Service) CDWConfirmReading(ctx context.Context, actor domain.User, id string,
	input CDWReadingConfirmationInput, key string) (ports.CDWReadingConfirmation, error) {
	var out ports.CDWReadingConfirmation
	input.Statement = strings.TrimSpace(input.Statement)
	if id == "" || !utf8.ValidString(input.Statement) || utf8.RuneCountInString(input.Statement) < 12 ||
		utf8.RuneCountInString(input.Statement) > 2000 {
		return out, domain.ErrInvalidInput
	}
	raw, err := s.cdwReadingMutate(ctx, actor, "reading.confirm", key,
		cdwCommandHash("reading.confirm", id, input), id, 200,
		func(tx ports.Tx, store ports.CDWReadingStore) (any, error) {
			fileID, e := store.CDWReadingAssignmentFile(ctx, id)
			if e != nil {
				return nil, e
			}
			if _, e = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			return store.CDWReadingConfirm(ctx, id, actor.ID, NewID("cdwreadevent"), input.Statement)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}
func (s *Service) CDWReadingContent(ctx context.Context, actor domain.User, id string) (io.ReadSeekCloser, string, int64, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, "", 0, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWReadingStore)
	if !ok {
		return nil, "", 0, domain.ErrInvalidInput
	}
	fileID, err := store.CDWReadingAssignmentFile(ctx, id)
	if err != nil {
		return nil, "", 0, err
	}
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return nil, "", 0, err
	}
	source, err := store.CDWReadingSource(ctx, id, actor.ID)
	if err != nil {
		return nil, "", 0, err
	}
	reader, err := s.blobs.Open(source.StorageKey)
	return reader, source.Name, source.SizeBytes, err
}

// CDWReadingContentDelivered is invoked by the streaming handler ONLY when
// its full exact blob was transmitted without a write/read error. Incomplete
// connections never unlock reading confirmation.
func (s *Service) CDWReadingContentDelivered(ctx context.Context, actor domain.User, id string) error {
	if id == "" {
		return domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWReadingStore)
	if !ok {
		return domain.ErrInvalidInput
	}
	fileID, err := store.CDWReadingAssignmentFile(ctx, id)
	if err != nil {
		return err
	}
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return err
	}
	eventID := NewID("cdwreadopened")
	changed, err := store.CDWReadingMarkOpened(ctx, id, actor.ID, eventID)
	if err != nil {
		return err
	}
	if changed {
		if err = auditRequired(ctx, tx, actor, "cdw.reading.opened", "reading_assignment", id,
			"success", map[string]any{"evidenceEventId": eventID, "transfer": "complete"}); err != nil {
			return err
		}
		if err = store.CDWReadingEvent(ctx, actor.ID, "reading.opened", id, eventID,
			map[string]any{"assignmentId": id, "openEventId": eventID, "transfer": "complete"}); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
