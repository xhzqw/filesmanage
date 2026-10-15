package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"unicode/utf8"
)

type CDWControlVerificationInput struct {
	Justification            string `json:"justification"`
	NoAdditionalSealRequired bool   `json:"noAdditionalSealRequired"`
	NoConversionRequired     bool   `json:"noConversionRequired"`
}

func (s *Service) CDWVerifyControlledRelease(ctx context.Context, actor domain.User, id string,
	input CDWControlVerificationInput, revision int64, key string) (ports.CDWControlledRelease, error) {
	var out ports.CDWControlledRelease
	input.Justification = strings.TrimSpace(input.Justification)
	if id == "" || revision < 1 || !input.NoAdditionalSealRequired || !input.NoConversionRequired ||
		!utf8.ValidString(input.Justification) || utf8.RuneCountInString(input.Justification) < 24 ||
		utf8.RuneCountInString(input.Justification) > 3000 {
		return out, domain.ErrInvalidInput
	}
	hash := cdwCommandHash("control.verify", id, struct {
		Input    CDWControlVerificationInput `json:"input"`
		Expected int64                       `json:"expected"`
	}{input, revision})
	raw, err := s.cdwControlMutate(ctx, actor, "control.verify", key, hash, id, 200,
		func(tx ports.Tx, store ports.CDWControlStore) (any, error) {
			fileID, e := store.CDWControlFile(ctx, id)
			if e != nil {
				return nil, e
			}
			if _, e = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			if _, e = store.CDWControlRole(ctx, actor.ID, "document_control", fileID); e != nil {
				return nil, e
			}
			return store.CDWControlVerify(ctx, id, NewID("cdwartifact"), NewID("cdwverification"),
				actor.ID, revision, input.Justification)
		})
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}
