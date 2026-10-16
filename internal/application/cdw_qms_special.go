package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"unicode/utf8"
)

type CDWQMSSpecialInput struct {
	FileID            string                         `json:"fileId"`
	Kind              string                         `json:"kind"`
	TemplateVersionID string                         `json:"templateVersionId"`
	PolicyReleaseID   string                         `json:"policyReleaseId"`
	Reason            string                         `json:"reason"`
	NodeClaims        []ports.CDWQMSSpecialNodeClaim `json:"nodeClaims"`
}
type CDWQMSSpecialReviewInput struct {
	Statement string `json:"statement"`
}

func (s *Service) CDWQMSSpecialPropose(ctx context.Context, actor domain.User, input CDWQMSSpecialInput, key string) (ports.CDWQMSSpecialAuthority, error) {
	var out ports.CDWQMSSpecialAuthority
	input.Reason = strings.TrimSpace(input.Reason)
	if !actor.IsAdmin {
		return out, domain.ErrForbidden
	}
	if input.FileID == "" || (input.Kind != "dhf" && input.Kind != "dmr") ||
		input.TemplateVersionID == "" || input.PolicyReleaseID == "" ||
		!utf8.ValidString(input.Reason) || utf8.RuneCountInString(input.Reason) < 16 ||
		utf8.RuneCountInString(input.Reason) > 2000 || len(input.NodeClaims) < 1 || len(input.NodeClaims) > 30 {
		return out, domain.ErrInvalidInput
	}
	for _, c := range input.NodeClaims {
		if c.NodeKey == "" || strings.TrimSpace(c.NodeKey) != c.NodeKey ||
			utf8.RuneCountInString(c.ClauseRef) < 2 || utf8.RuneCountInString(c.ClauseRef) > 200 ||
			utf8.RuneCountInString(c.BasisSummary) < 8 || utf8.RuneCountInString(c.BasisSummary) > 1000 {
			return out, domain.ErrInvalidInput
		}
	}
	id := NewID("cdwqmsspecial")
	raw, err := s.cdwFormalMutate(ctx, actor, "qms.special.propose", key,
		cdwCommandHash("qms.special.propose", input.FileID, input), input.FileID, 201,
		func(tx ports.Tx, store ports.CDWFormalStore) (any, error) {
			ctrl, ok := tx.(ports.CDWControlStore)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			policyFileID, e := ctrl.CDWControlFile(ctx, input.PolicyReleaseID)
			if e != nil {
				return nil, domain.ErrPolicyAuthorityPending
			}
			for _, fid := range []string{input.FileID, policyFileID} {
				if _, e = s.visibleFile(ctx, tx, actor, fid, domain.ActionPreview); e != nil {
					return nil, e
				}
			}
			return store.CDWQMSSpecialPropose(ctx, id, input.FileID, input.Kind, input.TemplateVersionID,
				input.PolicyReleaseID, actor.ID, input.Reason, input.NodeClaims)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}

func (s *Service) CDWQMSSpecialReview(ctx context.Context, actor domain.User, id string, input CDWQMSSpecialReviewInput, action, key string) (ports.CDWQMSSpecialAuthority, error) {
	var out ports.CDWQMSSpecialAuthority
	input.Statement = strings.TrimSpace(input.Statement)
	if id == "" || !utf8.ValidString(input.Statement) || utf8.RuneCountInString(input.Statement) < 16 ||
		utf8.RuneCountInString(input.Statement) > 2000 {
		return out, domain.ErrInvalidInput
	}
	if action != "verify" && action != "revoke" && action != "return" && action != "reject" {
		return out, domain.ErrInvalidInput
	}
	op := "qms.special." + action
	raw, err := s.cdwFormalMutate(ctx, actor, op, key,
		cdwCommandHash(op, id, input), id, 200,
		func(tx ports.Tx, store ports.CDWFormalStore) (any, error) {
			fid, policyFile, e := store.CDWQMSSpecialFile(ctx, id)
			if e != nil {
				return nil, e
			}
			for _, file := range []string{fid, policyFile} {
				if _, e = s.visibleFile(ctx, tx, actor, file, domain.ActionPreview); e != nil {
					return nil, e
				}
			}
			return store.CDWQMSSpecialReview(ctx, id, actor.ID, input.Statement, action)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}

func (s *Service) CDWQMSSpecialAlerts(ctx context.Context, actor domain.User) ([]ports.CDWQMSSpecialAlert, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWFormalStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	items, err := store.CDWQMSSpecialAlerts(ctx, actor.ID, 100)
	if err != nil {
		return nil, err
	}
	out := make([]ports.CDWQMSSpecialAlert, 0, len(items))
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
func (s *Service) CDWQMSSpecialReadAlert(ctx context.Context, actor domain.User, id, key string) (CDWQMSAlertReceipt, error) {
	var out CDWQMSAlertReceipt
	if id == "" {
		return out, domain.ErrInvalidInput
	}
	raw, err := s.cdwFormalMutate(ctx, actor, "qms.special.alert.read", key,
		cdwCommandHash("qms.special.alert.read", id, id), id, 200,
		func(_ ports.Tx, store ports.CDWFormalStore) (any, error) {
			ok, e := store.CDWQMSSpecialReadAlert(ctx, id, actor.ID)
			if e != nil {
				return nil, e
			}
			if !ok {
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

func (s *Service) CDWQMSSpecialList(ctx context.Context, actor domain.User) ([]ports.CDWQMSSpecialAuthority, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWFormalStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	items, err := store.CDWQMSSpecialList(ctx, actor.ID, 100)
	if err != nil {
		return nil, err
	}
	out := make([]ports.CDWQMSSpecialAuthority, 0, len(items))
	for _, item := range items {
		visible := true
		for _, fid := range []string{item.FileID, item.PolicyFileID} {
			if _, e := s.visibleFile(ctx, tx, actor, fid, domain.ActionPreview); e != nil {
				visible = false
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				break
			}
		}
		if visible {
			out = append(out, item)
		}
	}
	return out, nil
}
