package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/domain/dhf"
	"filesmanage/internal/ports"
)

// dhfPilotEvaluateTx consumes an already-started database transaction.
// Both advisory preflight and any future pilot submission MUST use this exact
// policy/manifest authorization path within their own transaction; a prior
// read-only preflight is NEVER a write authorization token.
func (s *Service) dhfPilotEvaluateTx(
	ctx context.Context, tx ports.Tx, store ports.DHFPilotSnapshotStore,
	actor domain.User, attemptID string, action dhf.Action,
) (DHFPilotPreflightResult, ports.DHFPilotAttemptRecord, []ports.DHFPilotEvidencePin, error) {
	fail := func(reason string) DHFPilotPreflightResult {
		return DHFPilotPreflightResult{
			Decision: dhf.Decision{Verdict: dhf.Deny, Reasons: []string{reason}},
			AdvisoryOnly: true,
		}
	}
	var empty ports.DHFPilotAttemptRecord
	row, err := store.DHFPilotAttemptForActor(ctx, attemptID, actor.ID)
	if errors.Is(err, ports.ErrRowMissing) {
		return fail("DHF_SCOPE_DENIED"), empty, nil, nil
	}
	if err != nil {
		return fail("DHF_SNAPSHOT_UNAVAILABLE"), empty, nil, err
	}
	trustedActor, err := tx.UserByID(ctx, actor.ID)
	if err != nil || trustedActor.ID != actor.ID || trustedActor.DisabledAt != nil {
		return fail("DHF_SCOPE_DENIED"), empty, nil, nil
	}
	if !checkPilotHash(row.PolicyBody, row.PolicyHash) || !checkPilotHash(row.ManifestBody, row.ManifestHash) {
		return fail("DHF_SOURCE_HASH_MISMATCH"), empty, nil, nil
	}
	var policyDoc dhfPilotPolicyDocument
	var manifest dhfPilotManifest
	if decodePilotJSON(row.PolicyBody, &policyDoc) != nil || !pilotPolicyFieldsComplete(row.PolicyBody) {
		return fail("DHF_POLICY_INVALID"), empty, nil, nil
	}
	if decodePilotJSON(row.ManifestBody, &manifest) != nil {
		return fail("DHF_MANIFEST_INVALID"), empty, nil, nil
	}
	if len(manifest.Requirements) > 1024 || len(policyDoc.Dependencies) > 256 ||
		len(policyDoc.Specialties) > 32 || len(policyDoc.Requirements) > 1024 {
		return fail("DHF_SNAPSHOT_TOO_LARGE"), empty, nil, nil
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
			// No decision or issuance authority in the V0.6 pilot.
			SeparationValid: false, FileReleaseApproved: false,
		},
	}
	pins := make([]ports.DHFPilotEvidencePin,0)
	for _, evidence := range manifest.Requirements {
		bound, verified := false, false
		if evidence.FileID != "" || evidence.VersionSeq != 0 || evidence.Sha256 != "" {
			// A partial file identity is never an acceptable attachment,
			// including when the requirement itself is optional.
			if evidence.FileID == "" || evidence.VersionSeq <= 0 || len(evidence.Sha256) != 64 {
				return fail("DHF_EVIDENCE_INVALID"), empty, nil, nil
			}
			// Project membership does not authorize a file download.
			if _, err := s.visibleFile(ctx, tx, trustedActor, evidence.FileID, domain.ActionDownload); err != nil {
				return fail("DHF_EVIDENCE_INVALID"), empty, nil, nil
			}
			version, err := tx.VersionBySeq(ctx, evidence.FileID, evidence.VersionSeq)
			if err != nil || version.Sha256 != evidence.Sha256 {
				return fail("DHF_EVIDENCE_INVALID"), empty, nil, nil
			}
			blob, err := tx.BlobByID(ctx, version.BlobID)
			if err != nil || blob.State != "ready" || blob.Sha256 != evidence.Sha256 {
				return fail("DHF_EVIDENCE_INVALID"), empty, nil, nil
			}
			bound, verified = true, true
			pins = append(pins, ports.DHFPilotEvidencePin{
				RequirementID: evidence.ID, FileID: evidence.FileID,
				VersionSeq: evidence.VersionSeq, BlobID: version.BlobID,
				Sha256: evidence.Sha256,
			})
		}
		input.Requirements = append(input.Requirements, dhf.RequirementResult{
			ID: evidence.ID, Applicability: evidence.Applicability,
			// An N/A requires a separate signed determination (not implemented).
			ApplicabilityAuthorized: false,
			EvidenceBound: bound, EvidenceVerified: verified,
		})
	}
	// Enumerate ALL policy edges. An absent predecessor is treated as
	// unaccepted; a client cannot filter out a blocking dependency.
	for _, dependency := range policyDoc.Dependencies {
		state, err := store.DHFPilotPredecessor(ctx, row.ProjectID, dependency.PredecessorStage)
		if err != nil {
			return fail("DHF_SNAPSHOT_UNAVAILABLE"), empty, nil, err
		}
		input.Dependencies = append(input.Dependencies, dhf.DependencyResult{
			ID: dependency.ID, PredecessorStage: dependency.PredecessorStage, State: state,
		})
	}
	return DHFPilotPreflightResult{Decision: dhf.Evaluate(input), AdvisoryOnly: true}, row, pins, nil
}
