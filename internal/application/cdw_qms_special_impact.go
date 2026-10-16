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

type CDWQMSSpecialImpactInput struct {
	Disposition string `json:"disposition"`
	Assessment  string `json:"assessment"`
}

func (s *Service) CDWQMSSpecialEvidence(ctx context.Context, actor domain.User, id string) (io.ReadSeekCloser, ports.CDWQMSSpecialEvidenceSource, error) {
	var empty ports.CDWQMSSpecialEvidenceSource
	if id == "" {
		return nil, empty, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, empty, err
	}
	defer tx.Rollback(ctx)
	formal, ok := tx.(ports.CDWFormalStore)
	if !ok {
		return nil, empty, domain.ErrInvalidInput
	}
	subject, policy, err := formal.CDWQMSSpecialFile(ctx, id)
	if err != nil {
		return nil, empty, err
	}
	for _, fid := range []string{subject, policy} {
		if _, err = s.visibleFile(ctx, tx, actor, fid, domain.ActionPreview); err != nil {
			return nil, empty, err
		}
	}
	control, ok := tx.(ports.CDWControlStore)
	if !ok {
		return nil, empty, domain.ErrInvalidInput
	}
	if _, err = control.CDWControlRole(ctx, actor.ID, "document_control", subject); err != nil {
		return nil, empty, err
	}
	source, err := formal.CDWQMSSpecialEvidenceSource(ctx, id)
	if err != nil {
		return nil, empty, err
	}
	reader, err := s.blobs.Open(source.StorageKey)
	if err != nil {
		return nil, empty, err
	}
	if err = auditRequired(ctx, tx, actor, "cdw.qms.special.evidence.requested", "qms_special_authority", id, "success",
		map[string]any{"releaseId": source.ReleaseID, "sha256": source.SHA256, "format": source.Format}); err != nil {
		_ = reader.Close()
		return nil, empty, err
	}
	if err = tx.Commit(ctx); err != nil {
		_ = reader.Close()
		return nil, empty, err
	}
	return reader, source, nil
}

func (s *Service) CDWQMSSpecialImpacts(ctx context.Context, actor domain.User) ([]ports.CDWQMSSpecialPolicyImpact, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWFormalStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	items, err := store.CDWQMSSpecialImpacts(ctx, actor.ID, 100)
	if err != nil {
		return nil, err
	}
	out := make([]ports.CDWQMSSpecialPolicyImpact, 0, len(items))
	for _, item := range items {
		visible := true
		for _, fid := range []string{item.SubjectFileID, item.PolicyFileID} {
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
func (s *Service) CDWQMSSpecialAssessImpact(ctx context.Context, actor domain.User, id string, input CDWQMSSpecialImpactInput, key string) (ports.CDWQMSSpecialPolicyImpact, error) {
	var out ports.CDWQMSSpecialPolicyImpact
	input.Assessment = strings.TrimSpace(input.Assessment)
	if id == "" || !utf8.ValidString(input.Assessment) || utf8.RuneCountInString(input.Assessment) < 16 ||
		utf8.RuneCountInString(input.Assessment) > 2000 ||
		(input.Disposition != "reapproval_required" && input.Disposition != "no_effect_on_existing_records") {
		return out, domain.ErrInvalidInput
	}
	raw, err := s.cdwFormalMutate(ctx, actor, "qms.special.impact.assess", key,
		cdwCommandHash("qms.special.impact.assess", id, input), id, 200,
		func(tx ports.Tx, store ports.CDWFormalStore) (any, error) {
			subject, policy, e := store.CDWQMSSpecialImpactFiles(ctx, id)
			if e != nil {
				return nil, e
			}
			for _, fid := range []string{subject, policy} {
				if _, e = s.visibleFile(ctx, tx, actor, fid, domain.ActionPreview); e != nil {
					return nil, e
				}
			}
			return store.CDWQMSSpecialAssessImpact(ctx, id, actor.ID, input.Disposition, input.Assessment)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}
