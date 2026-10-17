package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
)

const dhfGenesisSHA = "0000000000000000000000000000000000000000000000000000000000000000"

type DHFProofEvent = ports.DHFProofEvent

type DHFProofPage struct {
	ProjectID       string          `json:"projectId"`
	TemplateSHA256  string          `json:"templateSha256"`
	ChainVersion    string          `json:"chainVersion"`
	AnchorSHA256    string          `json:"anchorSha256"`
	SegmentVerified bool            `json:"segmentVerified"`
	StartsAtGenesis bool            `json:"startsAtGenesis"`
	HasMore         bool            `json:"hasMore"`
	NextAfter       int64           `json:"nextAfter"`
	Events          []DHFProofEvent `json:"events"`
}

type DHFAuditReader interface {
	DHFProofPage(context.Context, string, int64, int) (string, []DHFProofEvent, bool, error)
}

func DHFProofDigest(projectID, prev, payload string) string {
	digest := sha256.Sum256([]byte(strings.Join([]string{"dhf-event-v2", projectID, prev, payload}, "\n")))
	return hex.EncodeToString(digest[:])
}

func verifyDHFProofSegment(projectID, anchor string, events []DHFProofEvent) error {
	prev := anchor
	for _, e := range events {
		if e.PreviousSHA256 != prev || DHFProofDigest(projectID, prev, e.PayloadText) != e.EventSHA256 {
			return domain.ErrConflict
		}
		var payload struct {
			Action string `json:"action"`
			Actor  string `json:"actor"`
			Stage  int    `json:"stage"`
			Line   int    `json:"line"`
			Value  struct {
				FileID string `json:"fileId"`
			} `json:"value"`
		}
		if err := json.Unmarshal([]byte(e.PayloadText), &payload); err != nil {
			return domain.ErrConflict
		}
		if payload.Action != e.Action || payload.Actor != e.ActorID || payload.Stage != e.StageNo || payload.Line != e.SourceLine {
			return domain.ErrConflict
		}
		prev = e.EventSHA256
	}
	return nil
}

func (s *Service) DHFProof(ctx context.Context, actor domain.User, projectID string, after int64, limit int) (DHFProofPage, error) {
	out := DHFProofPage{ProjectID: projectID, ChainVersion: "dhf-event-v2", Events: []DHFProofEvent{}, StartsAtGenesis: after == 0}
	if after < 0 || limit < 1 || limit > 200 {
		return out, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.DHFStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	proofStore, ok := tx.(DHFAuditReader)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	project, err := store.DHFProjectByID(ctx, projectID, actor.ID, false)
	if err != nil {
		return out, err
	}
	out.TemplateSHA256 = project.TemplateSHA256
	anchor, events, hasMore, err := proofStore.DHFProofPage(ctx, projectID, after, limit)
	if err != nil {
		return out, err
	}
	if after == 0 && anchor != dhfGenesisSHA {
		return out, domain.ErrConflict
	}
	if err = verifyDHFProofSegment(projectID, anchor, events); err != nil {
		return out, err
	}
	// A DHF project assignment is never enough to reveal a source file's
	// historic identifier: continue enforcing actual file ACL on each event.
	checked := make(map[string]bool)
	for _, e := range events {
		var payload struct {
			Value struct {
				FileID string `json:"fileId"`
			} `json:"value"`
		}
		if err = json.Unmarshal([]byte(e.PayloadText), &payload); err != nil {
			return out, domain.ErrConflict
		}
		if id := payload.Value.FileID; id != "" && !checked[id] {
			if _, err = s.visibleFile(ctx, tx, actor, id, domain.ActionPreview); err != nil {
				return out, domain.ErrForbidden
			}
			checked[id] = true
		}
	}
	out.AnchorSHA256 = anchor
	out.Events = events
	out.HasMore = hasMore
	out.SegmentVerified = true
	if len(events) > 0 {
		out.NextAfter = events[len(events)-1].ID
	} else {
		out.NextAfter = after
	}
	return out, nil
}
