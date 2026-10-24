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

	row, err := store.DHFPilotAttemptForActor(ctx, attemptID, actor.ID)
	if errors.Is(err, ports.ErrRowMissing) {
		return fail("DHF_SCOPE_DENIED"), nil
	}
	if err != nil {
		return fail("DHF_SNAPSHOT_UNAVAILABLE"), err
	}
	if !checkPilotHash(row.PolicyBody, row.PolicyHash) || !checkPilotHash(row.ManifestBody, row.ManifestHash) {
		return fail("DHF_SOURCE_HASH_MISMATCH"), nil
	}
	var policyDoc dhfPilotPolicyDocument
	var manifest dhfPilotManifest
	if decodePilotJSON(row.PolicyBody, &policyDoc) != nil {
		return fail("DHF_POLICY_INVALID"), nil
	}
	if decodePilotJSON(row.ManifestBody, &manifest) != nil {
		return fail("DHF_MANIFEST_INVALID"), nil
	}

	input := dhf.GateInput{
		Action: action,
		Policy: dhf.PolicySnapshot{
			TemplateVersionID: row.TemplateVersionID,
			TemplateHash: row.PolicyHash,
			StageID: policyDoc.StageID,
			Published: row.PolicyStatus == "published" && row.TemplateApproved,
			ConditionalAllowed: policyDoc.ConditionalAllowed,
			Requirements: policyDoc.Requirements,
			Dependencies: policyDoc.Dependencies,
			Specialties: policyDoc.Specialties,
		},
		Stage: dhf.StageSnapshot{
			ProjectID: row.ProjectID, StageID: row.StageID,
			AttemptID: row.AttemptID, TemplateVersionID: row.TemplateVersionID,
			TemplateHash: row.PolicyHash, EvidenceManifestHash: row.ManifestHash,
			State: row.State,
			BaselineActive: row.BaselineActive && row.ProjectState == "active",
			ActorAuthorized: (action == dhf.ActionPrepare && row.CanPrepare) ||
				(action == dhf.ActionSubmit && row.CanSubmit),
			Now: s.now(),
			SeparationValid: false, FileReleaseApproved: false,
		},
	}
	if len(manifest.Requirements) > 1024 || len(input.Policy.Dependencies) > 256 {
		return fail("DHF_SNAPSHOT_TOO_LARGE"), nil
	}

	// Evaluate receives every manifest entry; it compares the set against the
	// authoritative policy and rejects missing, duplicated or extra results.
	for _, evidence := range manifest.Requirements {
		verified := false
		if evidence.FileID != "" && evidence.VersionSeq > 0 && len(evidence.Sha256) == 64 {
			// DHF project membership alone never grants access to a file.
			_, aclErr := s.visibleFile(ctx, tx, actor, evidence.FileID, domain.ActionDownload)
			if aclErr == nil {
				version, versionErr := tx.VersionBySeq(ctx, evidence.FileID, evidence.VersionSeq)
				if versionErr == nil && version.Sha256 == evidence.Sha256 {
					blob, blobErr := tx.BlobByID(ctx, version.BlobID)
					verified = blobErr == nil && blob.State == "ready" &&
						blob.Sha256 == evidence.Sha256
				}
			}
		}
		input.Requirements = append(input.Requirements, dhf.RequirementResult{
			ID: evidence.ID, Applicability: evidence.Applicability,
			// N/A requires separately approved applicability decisions; no
			// such approval channel exists in this pilot, so fail closed.
			ApplicabilityAuthorized: false,
			EvidenceBound: evidence.FileID != "" && evidence.VersionSeq > 0,
			EvidenceVerified: verified,
		})
	}

	// Resolve each dependency from the same project in the same DB snapshot.
	// An absent predecessor is blocked, never interpreted as no rule.
	for _, dependency := range policyDoc.Dependencies {
		state, err := store.DHFPilotPredecessor(ctx, row.ProjectID, dependency.PredecessorStage)
		if err != nil {
			return fail("DHF_SNAPSHOT_UNAVAILABLE"), err
		}
		input.Dependencies = append(input.Dependencies, dhf.DependencyResult{
			ID: dependency.ID, PredecessorStage: dependency.PredecessorStage, State: state,
		})
	}
	return DHFPilotPreflightResult{Decision: dhf.Evaluate(input), AdvisoryOnly: true}, nil
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
