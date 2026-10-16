package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"regexp"
	"strings"
	"unicode/utf8"
)

var cdwPaperCopyNo = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$`)

type CDWPaperIssueInput struct {
	CopyNumbers []string `json:"copyNumbers"`
}
type CDWPaperTransitionInput struct {
	Kind   string `json:"kind"`
	Reason string `json:"reason"`
}

func (s *Service) cdwPaperAuthorization(ctx context.Context, tx ports.Tx, actor domain.User, fileID string) error {
	if _, err := s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return err
	}
	roles, ok := tx.(ports.CDWControlStore)
	if !ok {
		return domain.ErrInvalidInput
	}
	_, err := roles.CDWControlRole(ctx, actor.ID, "document_control", fileID)
	return err
}
func (s *Service) CDWPaperLedger(ctx context.Context, actor domain.User, targetID string) (ports.CDWPaperLedger, error) {
	var out ports.CDWPaperLedger
	if targetID == "" {
		return out, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWPaperStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	fileID, err := store.CDWPaperTargetFile(ctx, targetID)
	if err != nil {
		return out, err
	}
	if err = s.cdwPaperAuthorization(ctx, tx, actor, fileID); err != nil {
		return out, err
	}
	return store.CDWPaperLedger(ctx, targetID)
}
func (s *Service) CDWPaperIssue(ctx context.Context, actor domain.User, targetID string,
	expected int64, input CDWPaperIssueInput, key string) (ports.CDWPaperLedger, error) {
	var out ports.CDWPaperLedger
	if targetID == "" || expected < 1 || len(input.CopyNumbers) < 1 || len(input.CopyNumbers) > 100 {
		return out, domain.ErrInvalidInput
	}
	seen := map[string]bool{}
	for i, number := range input.CopyNumbers {
		number = strings.TrimSpace(number)
		if !cdwPaperCopyNo.MatchString(number) || seen[number] {
			return out, domain.ErrInvalidInput
		}
		input.CopyNumbers[i] = number
		seen[number] = true
	}
	raw, err := s.cdwDistributionMutate(ctx, actor, "paper.issue", key,
		cdwCommandHash("paper.issue", targetID, struct {
			Expected int64
			Input    CDWPaperIssueInput
		}{expected, input}),
		targetID, 201, func(tx ports.Tx, _ ports.CDWDistributionStore) (any, error) {
			store, ok := tx.(ports.CDWPaperStore)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			fileID, e := store.CDWPaperTargetFile(ctx, targetID)
			if e != nil {
				return nil, e
			}
			if e = s.cdwPaperAuthorization(ctx, tx, actor, fileID); e != nil {
				return nil, e
			}
			ids := make([]string, len(input.CopyNumbers))
			for i := range ids {
				ids[i] = NewID("cdwpaper")
			}
			return store.CDWPaperIssue(ctx, targetID, NewID("cdwlot"), actor.ID, expected, ids, input.CopyNumbers)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}
func (s *Service) CDWPaperRecord(ctx context.Context, actor domain.User, copyID string,
	expected int64, input CDWPaperTransitionInput, key string) (ports.CDWPaperTransition, error) {
	var out ports.CDWPaperTransition
	input.Reason = strings.TrimSpace(input.Reason)
	if copyID == "" || expected < 1 || (!utf8.ValidString(input.Reason)) ||
		utf8.RuneCountInString(input.Reason) < 12 || utf8.RuneCountInString(input.Reason) > 2000 ||
		(input.Kind != "collected" && input.Kind != "destroyed" && input.Kind != "lost") {
		return out, domain.ErrInvalidInput
	}
	raw, err := s.cdwDistributionMutate(ctx, actor, "paper."+input.Kind, key,
		cdwCommandHash("paper.record", copyID, struct {
			Expected int64
			Input    CDWPaperTransitionInput
		}{expected, input}),
		copyID, 200, func(tx ports.Tx, _ ports.CDWDistributionStore) (any, error) {
			store, ok := tx.(ports.CDWPaperStore)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			fileID, e := store.CDWPaperCopyFile(ctx, copyID)
			if e != nil {
				return nil, e
			}
			if e = s.cdwPaperAuthorization(ctx, tx, actor, fileID); e != nil {
				return nil, e
			}
			return store.CDWPaperTransition(ctx, copyID, NewID("cdwpaperevt"), actor.ID, expected, input.Kind, input.Reason)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}
