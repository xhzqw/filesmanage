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

type CDWQMSRevocationInput struct {
	Reason string `json:"reason"`
}
type CDWQMSAlertReceipt struct {
	ID   string `json:"id"`
	Read bool   `json:"read"`
}

func (s *Service) CDWQMSRevokeAppointment(ctx context.Context, actor domain.User, id string, input CDWQMSRevocationInput, key string) (ports.CDWQMSAppointment, error) {
	var out ports.CDWQMSAppointment
	input.Reason = strings.TrimSpace(input.Reason)
	if id == "" || !utf8.ValidString(input.Reason) || utf8.RuneCountInString(input.Reason) < 16 || utf8.RuneCountInString(input.Reason) > 2000 {
		return out, domain.ErrInvalidInput
	}
	raw, err := s.cdwFormalMutate(ctx, actor, "qms.appointment.revoke", key,
		cdwCommandHash("qms.appointment.revoke", id, input), id, 200,
		func(tx ports.Tx, store ports.CDWFormalStore) (any, error) {
			fid, e := store.CDWQMSAppointmentFile(ctx, id)
			if e != nil {
				return nil, e
			}
			if _, e = s.visibleFile(ctx, tx, actor, fid, domain.ActionPreview); e != nil {
				return nil, e
			}
			return store.CDWQMSRevokeAppointment(ctx, id, actor.ID, input.Reason)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}

func (s *Service) CDWQMSAlerts(ctx context.Context, actor domain.User) ([]ports.CDWQMSAppointmentAlert, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWFormalStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	items, err := store.CDWQMSAppointmentAlerts(ctx, actor.ID, 100)
	if err != nil {
		return nil, err
	}
	out := make([]ports.CDWQMSAppointmentAlert, 0, len(items))
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

func (s *Service) CDWQMSReadAlert(ctx context.Context, actor domain.User, id, key string) (CDWQMSAlertReceipt, error) {
	var out CDWQMSAlertReceipt
	if id == "" {
		return out, domain.ErrInvalidInput
	}
	raw, err := s.cdwFormalMutate(ctx, actor, "qms.appointment.alert.read", key,
		cdwCommandHash("qms.appointment.alert.read", id, id), id, 200,
		func(_ ports.Tx, store ports.CDWFormalStore) (any, error) {
			ok, e := store.CDWQMSReadAppointmentAlert(ctx, id, actor.ID)
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

// Stream the exact immutable, already effective and dispatched DOCX belonging
// to the appointment's EVIDENCE release. Never consult mutable file latest.
func (s *Service) CDWQMSAppointmentEvidence(ctx context.Context, actor domain.User, id string) (io.ReadSeekCloser, string, int64, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, "", 0, err
	}
	defer tx.Rollback(ctx)
	formal, ok := tx.(ports.CDWFormalStore)
	if !ok {
		return nil, "", 0, domain.ErrInvalidInput
	}
	subjectFile, e := formal.CDWQMSAppointmentFile(ctx, id)
	if e != nil {
		return nil, "", 0, e
	}
	policyFile, evidenceFile, e := formal.CDWQMSAppointmentSourceFiles(ctx, id)
	if e != nil {
		return nil, "", 0, e
	}
	for _, fid := range []string{subjectFile, policyFile, evidenceFile} {
		if _, e = s.visibleFile(ctx, tx, actor, fid, domain.ActionPreview); e != nil {
			return nil, "", 0, e
		}
	}
	control, ok := tx.(ports.CDWControlStore)
	if !ok {
		return nil, "", 0, domain.ErrInvalidInput
	}
	if _, e = control.CDWControlRole(ctx, actor.ID, "document_control", subjectFile); e != nil {
		return nil, "", 0, e
	}
	source, e := formal.CDWQMSAppointmentEvidenceSource(ctx, id)
	if e != nil {
		return nil, "", 0, e
	}
	reader, e := s.blobs.Open(source.StorageKey)
	if e != nil {
		return nil, "", 0, e
	}
	return reader, source.SHA256, source.SizeBytes, nil
}
