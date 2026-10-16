package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

type CDWQMSAppointmentInput struct {
	FileID            string `json:"fileId"`
	UserID            string `json:"userId"`
	NodeKey           string `json:"nodeKey"`
	PolicyReleaseID   string `json:"policyReleaseId"`
	EvidenceReleaseID string `json:"evidenceReleaseId"`
	ExpiresAt         string `json:"expiresAt"`
	Reason            string `json:"reason"`
}
type CDWQMSVerifyInput struct {
	Statement string `json:"statement"`
}

var cdwQMSNodeKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)

func (s *Service) CDWQMSProposeAppointment(ctx context.Context, actor domain.User, input CDWQMSAppointmentInput, key string) (ports.CDWQMSAppointment, error) {
	var out ports.CDWQMSAppointment
	if !actor.IsAdmin {
		return out, domain.ErrForbidden
	}
	input.Reason = strings.TrimSpace(input.Reason)
	expires, err := time.Parse(time.RFC3339, input.ExpiresAt)
	if err != nil || !cdwQMSNodeKeyPattern.MatchString(input.NodeKey) ||
		input.FileID == "" || input.UserID == "" || input.PolicyReleaseID == "" || input.EvidenceReleaseID == "" ||
		utf8.RuneCountInString(input.Reason) < 16 || utf8.RuneCountInString(input.Reason) > 2000 {
		return out, domain.ErrInvalidInput
	}
	id := NewID("cdwqmsappointment")
	raw, err := s.cdwFormalMutate(ctx, actor, "qms.appointment.propose", key,
		cdwCommandHash("qms.appointment.propose", input.FileID, input), input.FileID, 201,
		func(tx ports.Tx, store ports.CDWFormalStore) (any, error) {
			if _, e := s.visibleFile(ctx, tx, actor, input.FileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			ctrl, ok := tx.(ports.CDWControlStore)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			for _, releaseID := range []string{input.PolicyReleaseID, input.EvidenceReleaseID} {
				sourceFileID, e := ctrl.CDWControlFile(ctx, releaseID)
				if e != nil {
					return nil, domain.ErrPolicyAuthorityPending
				}
				if _, e = s.visibleFile(ctx, tx, actor, sourceFileID, domain.ActionPreview); e != nil {
					return nil, domain.ErrForbidden
				}
			}
			person, e := tx.UserByID(ctx, input.UserID)
			if e != nil || person.DisabledAt != nil {
				return nil, domain.ErrForbidden
			}
			return store.CDWQMSProposeAppointment(ctx, id, input.FileID, input.UserID, input.NodeKey,
				input.PolicyReleaseID, input.EvidenceReleaseID, actor.ID, expires, input.Reason)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}

func (s *Service) CDWQMSVerifyAppointment(ctx context.Context, actor domain.User, id string, input CDWQMSVerifyInput, key string) (ports.CDWQMSAppointment, error) {
	var out ports.CDWQMSAppointment
	input.Statement = strings.TrimSpace(input.Statement)
	if id == "" || utf8.RuneCountInString(input.Statement) < 16 || utf8.RuneCountInString(input.Statement) > 2000 {
		return out, domain.ErrInvalidInput
	}
	raw, err := s.cdwFormalMutate(ctx, actor, "qms.appointment.verify", key,
		cdwCommandHash("qms.appointment.verify", id, input), id, 200,
		func(tx ports.Tx, store ports.CDWFormalStore) (any, error) {
			fileID, e := store.CDWQMSAppointmentFile(ctx, id)
			if e != nil {
				return nil, e
			}
			if _, e = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			policyFile, evidenceFile, e := store.CDWQMSAppointmentSourceFiles(ctx, id)
			if e != nil {
				return nil, e
			}
			for _, sourceFileID := range []string{policyFile, evidenceFile} {
				if _, e = s.visibleFile(ctx, tx, actor, sourceFileID, domain.ActionPreview); e != nil {
					return nil, domain.ErrForbidden
				}
			}
			return store.CDWQMSVerifyAppointment(ctx, id, actor.ID, input.Statement)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}

func (s *Service) CDWQMSAppointments(ctx context.Context, actor domain.User, fileID string) ([]ports.CDWQMSAppointment, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return nil, err
	}
	if !actor.IsAdmin {
		ctrl, ok := tx.(ports.CDWControlStore)
		if !ok {
			return nil, domain.ErrInvalidInput
		}
		if _, err = ctrl.CDWControlRole(ctx, actor.ID, "document_control", fileID); err != nil {
			return nil, domain.ErrForbidden
		}
	}
	store, ok := tx.(ports.CDWFormalStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	return store.CDWQMSListAppointments(ctx, fileID)
}

func (s *Service) CDWQMSPendingReview(ctx context.Context, actor domain.User) ([]ports.CDWQMSPendingReview, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWFormalStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	items, err := store.CDWQMSPendingReview(ctx, actor.ID, 100)
	if err != nil {
		return nil, err
	}
	out := make([]ports.CDWQMSPendingReview, 0, len(items))
	for _, item := range items {
		visible := true
		policyFileID, evidenceFileID, e := store.CDWQMSAppointmentSourceFiles(ctx, item.ID)
		if e != nil {
			continue
		}
		for _, fileID := range []string{item.FileID, policyFileID, evidenceFileID} {
			if _, e = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); e != nil {
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
