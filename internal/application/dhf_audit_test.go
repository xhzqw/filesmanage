package application

import (
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"testing"
)

func TestDHFProofSegmentDetectsAlteredPayloadAndDisconnectedLink(t *testing.T) {
	payload, _ := json.Marshal(map[string]any{"action": "project.create", "actor": "reviewer", "stage": 0, "line": 0, "value": map[string]any{"title": "DHF原始项目"}})
	anchor := dhfGenesisSHA
	sha := DHFProofDigest("dhf_project_a", anchor, string(payload))
	event := DHFProofEvent{ID: 1, Action: "project.create", ActorID: "reviewer", StageNo: 0, SourceLine: 0, PayloadText: string(payload), PreviousSHA256: anchor, EventSHA256: sha}
	if err := verifyDHFProofSegment("dhf_project_a", anchor, []DHFProofEvent{event}); err != nil {
		t.Fatal(err)
	}
	if err := verifyDHFProofSegment("dhf_project_b", anchor, []DHFProofEvent{event}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("project scoped hash collision accepted: %v", err)
	}
	tamper := event
	tamper.PayloadText += ` `
	if err := verifyDHFProofSegment("dhf_project_a", anchor, []DHFProofEvent{tamper}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("modified payload accepted: %v", err)
	}
	tamper = event
	tamper.ActorID = "someone_else"
	if err := verifyDHFProofSegment("dhf_project_a", anchor, []DHFProofEvent{tamper}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("mismatched actor accepted: %v", err)
	}
	tamper = event
	tamper.PreviousSHA256 = "deadbeef"
	if err := verifyDHFProofSegment("dhf_project_a", anchor, []DHFProofEvent{tamper}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("disconnected chain accepted: %v", err)
	}
}
