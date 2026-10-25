package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/domain/dhf"
	"filesmanage/internal/ports"
	"fmt"
	"io"
)

// DHFPilotPreflightResult is advisory only. It never authorizes a state change,
// controlled release, evidence retention policy or official DHF approval.
type DHFPilotPreflightResult struct {
	Decision     dhf.Decision
	AdvisoryOnly bool
}

type dhfPilotPolicyDocument struct {
	StageID            string                   `json:"stage_id"`
	ConditionalAllowed bool                     `json:"conditional_allowed"`
	Requirements       []dhf.RequirementPolicy  `json:"requirements"`
	Dependencies       []dhf.DependencyPolicy   `json:"dependencies"`
	Specialties        []dhf.SpecialtyPolicy    `json:"specialties"`
}

type dhfPilotManifest struct {
	Requirements []dhfPilotEvidence `json:"requirements"`
}

type dhfPilotEvidence struct {
	ID            string            `json:"id"`
	Applicability dhf.Applicability `json:"applicability"`
	FileID        string            `json:"file_id"`
	VersionSeq    int               `json:"version_seq"`
	Sha256        string            `json:"sha256"`
}

// The browser never supplies a policy, a GateInput or any authorization flags.
// Only prepare/submit can receive advisory responses in this first slice.
func (s *Service) DHFPilotPreflight(ctx context.Context, actor domain.User, attemptID string, action dhf.Action) (DHFPilotPreflightResult, error) {
	fail := func(reason string) DHFPilotPreflightResult {
		return DHFPilotPreflightResult{
			Decision: dhf.Decision{Verdict: dhf.Deny, Reasons: []string{reason}},
			AdvisoryOnly: true,
		}
	}
	if actor.ID == "" || attemptID == "" {
		return fail("DHF_SCOPE_DENIED"), nil
	}
	if action != dhf.ActionPrepare && action != dhf.ActionSubmit {
		return fail("DHF_PILOT_ACTION_DISABLED"), nil
	}

	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return fail("DHF_SNAPSHOT_UNAVAILABLE"), err
	}
	defer tx.Rollback(ctx)
	store, supported := any(tx).(ports.DHFPilotSnapshotStore)
	if !supported {
		return fail("DHF_SNAPSHOT_UNAVAILABLE"), errors.New("DHF snapshot adapter unavailable")
	}
	if err := store.DHFPilotBeginSnapshot(ctx); err != nil {
		return fail("DHF_SNAPSHOT_UNAVAILABLE"), err
	}

	result, _, _, err := s.dhfPilotEvaluateTx(ctx, tx, store, actor, attemptID, action)
	return result, err
}

func checkPilotHash(body []byte, stored string) bool {
	hash := sha256.Sum256(body)
	return hex.EncodeToString(hash[:]) == stored
}

func decodePilotJSON(body []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("DHF JSON contains additional input: %v", err)
	}
	return nil
}


// Explicit boolean presence matters: an omitted Mandatory field must not
// silently decode to false and turn a published obligation into an optional one.
// Policy payloads use the Go wire names of the dhf domain value structs.
func pilotPolicyFieldsComplete(raw []byte) bool {
	var root map[string]json.RawMessage
	if json.Unmarshal(raw, &root) != nil {
		return false
	}
	var enabled *bool
	if json.Unmarshal(root["conditional_allowed"], &enabled) != nil || enabled == nil {
		return false
	}
	var requirements []map[string]json.RawMessage
	if json.Unmarshal(root["requirements"], &requirements) != nil || len(requirements) == 0 {
		return false
	}
	for _, item := range requirements {
		if len(item["ID"]) == 0 {
			return false
		}
		for _, field := range []string{"Mandatory","Critical","ConditionEligible","AllowNotApplicable"} {
			var value *bool
			if json.Unmarshal(item[field], &value) != nil || value == nil {
				return false
			}
		}
	}
	var deps []map[string]json.RawMessage
	if json.Unmarshal(root["dependencies"], &deps) != nil && len(root["dependencies"]) != 0 {
		return false
	}
	for _, item := range deps {
		if len(item["ID"]) == 0 || len(item["PredecessorStage"]) == 0 || len(item["GuardedAction"]) == 0 {
			return false
		}
		var value *bool
		if json.Unmarshal(item["AllowConditional"], &value) != nil || value == nil {
			return false
		}
	}
	var specialties []map[string]json.RawMessage
	if json.Unmarshal(root["specialties"], &specialties) != nil && len(root["specialties"]) != 0 {
		return false
	}
	for _, item := range specialties {
		if len(item["Key"]) == 0 {
			return false
		}
		var value *bool
		if json.Unmarshal(item["AllowNotApplicable"], &value) != nil || value == nil {
			return false
		}
	}
	return true
}
