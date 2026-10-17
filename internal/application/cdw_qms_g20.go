package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"unicode/utf8"
)

type CDWQMSEscalationProposalInput struct {
	TargetFileID    string `json:"targetFileId"`
	PolicyReleaseID string `json:"policyReleaseId"`
	ClauseRef       string `json:"clauseRef"`
	DelayMinutes    int    `json:"delayMinutes"`
	OwnerID         string `json:"ownerId"`
	Reason          string `json:"reason"`
}
type CDWQMSEscalationReasonInput struct {
	Reason string `json:"reason"`
}
type CDWQMSEscalationOpenInput struct {
	PolicyID string `json:"policyId"`
	Reason   string `json:"reason"`
}

func cdwG20ReasonValid(v string) bool {
	return utf8.ValidString(v) && utf8.RuneCountInString(v) >= 16 && utf8.RuneCountInString(v) <= 2000
}

func (s *Service) CDWQMSEscalationPropose(ctx context.Context, actor domain.User,
	input CDWQMSEscalationProposalInput, key string) (ports.CDWQMSEscalationPolicy, error) {
	var empty ports.CDWQMSEscalationPolicy
	input.Reason = strings.TrimSpace(input.Reason)
	input.ClauseRef = strings.TrimSpace(input.ClauseRef)
	if input.TargetFileID == "" || input.PolicyReleaseID == "" || input.OwnerID == "" ||
		!cdwG20ReasonValid(input.Reason) || !utf8.ValidString(input.ClauseRef) ||
		utf8.RuneCountInString(input.ClauseRef) < 3 || utf8.RuneCountInString(input.ClauseRef) > 180 ||
		input.DelayMinutes < 60 || input.DelayMinutes > 525600 {
		return empty, domain.ErrInvalidInput
	}
	policyID := NewID("cdwqmspolicy")
	raw, err := s.cdwFormalMutate(ctx, actor, "qms.escalation.propose", key,
		cdwCommandHash("qms.escalation.propose", input.TargetFileID, input),
		input.TargetFileID, 201, func(tx ports.Tx, _ ports.CDWFormalStore) (any, error) {
			repo, ok := tx.(ports.CDWQMSG16Store)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			if _, e := s.visibleFile(ctx, tx, actor, input.TargetFileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			source, e := repo.CDWQMSEscalationSourceFile(ctx, input.PolicyReleaseID)
			if e != nil {
				return nil, e
			}
			if _, e = s.visibleFile(ctx, tx, actor, source, domain.ActionPreview); e != nil {
				return nil, e
			}
			return repo.CDWQMSEscalationPropose(ctx, policyID, ports.CDWQMSEscalationPolicy{
				TargetFileID: input.TargetFileID, PolicyReleaseID: input.PolicyReleaseID,
				ClauseRef: input.ClauseRef, DelayMinutes: input.DelayMinutes,
				OwnerID: input.OwnerID, Reason: input.Reason, ProposedBy: actor.ID})
		})
	if err != nil {
		return empty, err
	}
	err = json.Unmarshal(raw, &empty)
	return empty, err
}
func (s *Service) CDWQMSEscalationVerify(ctx context.Context, actor domain.User, id string,
	input CDWQMSEscalationReasonInput, key string) (ports.CDWQMSEscalationPolicy, error) {
	var empty ports.CDWQMSEscalationPolicy
	input.Reason = strings.TrimSpace(input.Reason)
	if id == "" || !cdwG20ReasonValid(input.Reason) {
		return empty, domain.ErrInvalidInput
	}
	raw, err := s.cdwFormalMutate(ctx, actor, "qms.escalation.verify", key,
		cdwCommandHash("qms.escalation.verify", id, input), id, 200,
		func(tx ports.Tx, _ ports.CDWFormalStore) (any, error) {
			repo, ok := tx.(ports.CDWQMSG16Store)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			fileID, e := repo.CDWQMSEscalationContextFile(ctx, id, "policy")
			if e != nil {
				return nil, e
			}
			if _, e = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			source, e := repo.CDWQMSEscalationPolicySourceFile(ctx, id)
			if e != nil {
				return nil, e
			}
			if _, e = s.visibleFile(ctx, tx, actor, source, domain.ActionPreview); e != nil {
				return nil, e
			}
			return repo.CDWQMSEscalationVerify(ctx, id, actor.ID, input.Reason)
		})
	if err != nil {
		return empty, err
	}
	err = json.Unmarshal(raw, &empty)
	return empty, err
}
func (s *Service) CDWQMSEscalationOpen(ctx context.Context, actor domain.User, noticeID string,
	input CDWQMSEscalationOpenInput, key string) (ports.CDWQMSEscalationCase, error) {
	var empty ports.CDWQMSEscalationCase
	input.Reason = strings.TrimSpace(input.Reason)
	if noticeID == "" || input.PolicyID == "" || !cdwG20ReasonValid(input.Reason) {
		return empty, domain.ErrInvalidInput
	}
	caseID := NewID("cdwqmscase")
	raw, err := s.cdwFormalMutate(ctx, actor, "qms.escalation.open", key,
		cdwCommandHash("qms.escalation.open", noticeID, input), noticeID, 201,
		func(tx ports.Tx, _ ports.CDWFormalStore) (any, error) {
			repo, ok := tx.(ports.CDWQMSG16Store)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			fileID, e := repo.CDWQMSFormalNoticeFile(ctx, noticeID)
			if e != nil {
				return nil, e
			}
			if _, e = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			return repo.CDWQMSEscalationOpen(ctx, caseID, noticeID, input.PolicyID, actor.ID, input.Reason)
		})
	if err != nil {
		return empty, err
	}
	err = json.Unmarshal(raw, &empty)
	return empty, err
}
func (s *Service) CDWQMSEscalationResolve(ctx context.Context, actor domain.User, caseID string,
	input CDWQMSEscalationReasonInput, key string) (ports.CDWQMSEscalationResolution, error) {
	var empty ports.CDWQMSEscalationResolution
	input.Reason = strings.TrimSpace(input.Reason)
	if caseID == "" || !cdwG20ReasonValid(input.Reason) {
		return empty, domain.ErrInvalidInput
	}
	raw, err := s.cdwFormalMutate(ctx, actor, "qms.escalation.resolve", key,
		cdwCommandHash("qms.escalation.resolve", caseID, input), caseID, 200,
		func(tx ports.Tx, _ ports.CDWFormalStore) (any, error) {
			repo, ok := tx.(ports.CDWQMSG16Store)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			fileID, e := repo.CDWQMSEscalationContextFile(ctx, caseID, "case")
			if e != nil {
				return nil, e
			}
			if _, e = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			return repo.CDWQMSEscalationResolve(ctx, NewID("cdwqmsresolve"), caseID, actor.ID, input.Reason)
		})
	if err != nil {
		return empty, err
	}
	err = json.Unmarshal(raw, &empty)
	return empty, err
}
func (s *Service) CDWQMSEscalationPolicies(ctx context.Context, actor domain.User) ([]ports.CDWQMSEscalationPolicy, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	repo, ok := tx.(ports.CDWQMSG16Store)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	all, err := repo.CDWQMSEscalationPolicies(ctx, actor.ID, 100)
	if err != nil {
		return nil, err
	}
	out := []ports.CDWQMSEscalationPolicy{}
	for _, p := range all {
		if _, e := s.visibleFile(ctx, tx, actor, p.TargetFileID, domain.ActionPreview); e == nil {
			out = append(out, p)
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	return out, nil
}
func (s *Service) CDWQMSEscalationCases(ctx context.Context, actor domain.User) ([]ports.CDWQMSEscalationCase, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	repo, ok := tx.(ports.CDWQMSG16Store)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	all, err := repo.CDWQMSEscalationCases(ctx, actor.ID, 100)
	if err != nil {
		return nil, err
	}
	out := []ports.CDWQMSEscalationCase{}
	for _, c := range all {
		if _, e := s.visibleFile(ctx, tx, actor, c.TargetFileID, domain.ActionPreview); e == nil {
			out = append(out, c)
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	return out, nil
}
