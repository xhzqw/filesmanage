package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/domain/dhf"
	"filesmanage/internal/ports"
	"sort"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

// Stage Gate readiness is a snapshot for review intake; nothing returned by
// this service is a corporate signature, approval, or accepted predecessor.
type DHFStageGateReadiness struct {
	SubmissionID              string                         `json:"submissionId"`
	CandidateID               string                         `json:"candidateId"`
	ProjectID                 string                         `json:"projectId"`
	StageID                   string                         `json:"stageId"`
	TemplateID                string                         `json:"templateId"`
	PolicySHA                 string                         `json:"policySha"`
	ManifestSHA               string                         `json:"manifestSha"`
	Dependencies              []ports.DHFStageGateDependency `json:"dependencies"`
	MissingPreconditions      []string                       `json:"missingPreconditions"`
	StrictRequestAllowed      bool                           `json:"strictRequestAllowed"`
	ConditionalRequestAllowed bool                           `json:"conditionalRequestAllowed"`
	FormalAccepted            bool                           `json:"formalAccepted"`
	TrialOnly                 bool                           `json:"trialOnly"`
	ReviewID                  string                         `json:"reviewId,omitempty"`
	ReviewState               string                         `json:"reviewState,omitempty"`
}
type DHFStageGateRequestInput struct {
	Mode           string `json:"mode"`
	Password       string `json:"password"`
	IdempotencyKey string `json:"idempotencyKey"`
}
type DHFStageGateRequestOutcome struct {
	ReviewID       string `json:"reviewId,omitempty"`
	SubmissionID   string `json:"submissionId"`
	State          string `json:"state,omitempty"`
	Replayed       bool   `json:"replayed"`
	TrialOnly      bool   `json:"trialOnly"`
	FormalAccepted bool   `json:"formalAccepted"`
	Reason         string `json:"reason,omitempty"`
}

func (s *Service) dhfStageGateReadinessTx(ctx context.Context, store ports.DHFStageGateReviewStore,
	actor domain.User, submissionID string) (DHFStageGateReadiness, ports.DHFStageGateReviewSource, error) {
	out := DHFStageGateReadiness{SubmissionID: submissionID, TrialOnly: true,
		Dependencies: []ports.DHFStageGateDependency{}, MissingPreconditions: []string{}, FormalAccepted: false}
	source, err := store.DHFStageGateReviewSourceForSigner(ctx, submissionID, actor.ID)
	if err != nil {
		return out, source, err
	}
	candidate := source.Candidate
	out.CandidateID = candidate.ID
	out.StageID = candidate.StageID
	out.ProjectID = candidate.ProjectID
	out.TemplateID = candidate.TemplateID
	out.PolicySHA = candidate.PolicySHA
	out.ManifestSHA = candidate.ManifestSHA
	if !source.Published || !checkPilotHash(source.PolicyBody, candidate.PolicySHA) {
		return out, source, errors.New("published Gate policy missing or changed")
	}
	if candidate.SigningCredentialID == "" {
		return out, source, errors.New("legacy unbound signing credential cannot initiate formal Gate review")
	}
	valid, _, _ := verifyHistoricalDHFPilotGate(candidate)
	if !valid {
		return out, source, errors.New("Gate candidate cryptographic verification failed")
	}
	var doc dhfPilotPolicyDocument
	if decodePilotJSON(source.PolicyBody, &doc) != nil ||
		!pilotPolicyFieldsComplete(source.PolicyBody) || doc.StageID != candidate.StageID ||
		len(doc.Dependencies) > 256 {
		return out, source, errors.New("frozen published Gate policy invalid")
	}
	seen := make(map[string]bool, len(doc.Dependencies))
	for _, dep := range doc.Dependencies {
		if dep.ID == "" || seen[dep.ID] || dep.PredecessorStage == candidate.StageID ||
			!validDHFStageDependency(dep.PredecessorStage) || dep.GuardedAction == "" {
			return out, source, errors.New("invalid/duplicate/cyclic-self stage dependency in published template")
		}
		seen[dep.ID] = true
		status, err := store.DHFStageGateObservedDependency(ctx, candidate.ProjectID, dep.PredecessorStage)
		if err != nil {
			return out, source, err
		}
		out.Dependencies = append(out.Dependencies, ports.DHFStageGateDependency{
			ID: dep.ID, PredecessorStage: dep.PredecessorStage,
			GuardedAction: string(dep.GuardedAction), State: status})
	}
	sort.Slice(out.Dependencies, func(i, j int) bool { return out.Dependencies[i].ID < out.Dependencies[j].ID })
	blocked := make(map[string]bool)
	for _, dep := range out.Dependencies {
		if dep.State != string(dhf.Accepted) {
			blocked["UNACCEPTED_PREDECESSOR:"+dep.PredecessorStage] = true
		}
	}
	for reason := range blocked {
		out.MissingPreconditions = append(out.MissingPreconditions, reason)
	}
	sort.Strings(out.MissingPreconditions)
	out.MissingPreconditions = append(out.MissingPreconditions, "ENTERPRISE_GATE_AUTHORITY_NOT_APPROVED")
	// A corporate SOP/independent signer and issuance authority is missing.
	// A request is possible, but never an approval or downstream permission.
	out.StrictRequestAllowed = true
	out.ConditionalRequestAllowed = false
	previous, err := store.DHFStageGateReviewBySubmission(ctx, submissionID)
	if err == nil {
		out.ReviewID = previous.ID
		out.ReviewState = previous.State
	} else if !errors.Is(err, ports.ErrRowMissing) {
		return out, source, err
	}
	return out, source, nil
}

func validDHFStageDependency(stage string) bool {
	switch stage {
	case "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9":
		return true
	}
	return false
}

func (s *Service) DHFStageGateReadiness(ctx context.Context, actor domain.User, submissionID string) (DHFStageGateReadiness, error) {
	if actor.ID == "" || submissionID == "" {
		return DHFStageGateReadiness{}, ports.ErrRowMissing
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return DHFStageGateReadiness{}, err
	}
	defer tx.Rollback(ctx)
	store, ok := any(tx).(ports.DHFStageGateReviewStore)
	if !ok {
		return DHFStageGateReadiness{}, errors.New("DHF Stage Gate review store missing")
	}
	if err = store.DHFPilotBeginSubmission(ctx); err != nil {
		return DHFStageGateReadiness{}, err
	}
	result, _, err := s.dhfStageGateReadinessTx(ctx, store, actor, submissionID)
	return result, err
}

func (s *Service) DHFStageGateRequest(ctx context.Context, actor domain.User, submissionID string, input DHFStageGateRequestInput) (DHFStageGateRequestOutcome, error) {
	fail := func(reason string) DHFStageGateRequestOutcome {
		return DHFStageGateRequestOutcome{
			SubmissionID: submissionID, TrialOnly: true, FormalAccepted: false, Reason: reason}
	}
	if actor.ID == "" || submissionID == "" {
		return fail("DHF_SCOPE_DENIED"), nil
	}
	if input.Mode != "strict" {
		return fail("DHF_CONDITIONAL_GATE_NOT_AUTHORIZED"), nil
	}
	if len(input.IdempotencyKey) < 8 || len(input.IdempotencyKey) > 160 ||
		strings.TrimSpace(input.IdempotencyKey) != input.IdempotencyKey {
		return fail("DHF_IDEMPOTENCY_KEY_INVALID"), nil
	}
	if len(input.Password) < 1 || len(input.Password) > 1024 {
		return fail("DHF_REAUTH_FAILED"), nil
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return fail("DHF_GATE_REVIEW_UNAVAILABLE"), err
	}
	defer tx.Rollback(ctx)
	store, ok := any(tx).(ports.DHFStageGateReviewStore)
	if !ok {
		return fail("DHF_GATE_REVIEW_UNAVAILABLE"), errors.New("Gate review store missing")
	}
	if err = store.DHFPilotBeginSubmission(ctx); err != nil {
		return fail("DHF_GATE_REVIEW_UNAVAILABLE"), err
	}
	ready, source, err := s.dhfStageGateReadinessTx(ctx, store, actor, submissionID)
	if errors.Is(err, ports.ErrRowMissing) {
		return fail("DHF_SCOPE_DENIED"), nil
	}
	if err != nil {
		return fail("DHF_GATE_REVIEW_PRECONDITION"), err
	}
	trusted, err := tx.UserByID(ctx, actor.ID)
	if err != nil || trusted.ID != actor.ID || trusted.DisabledAt != nil ||
		trusted.MustChangePassword || trusted.Login == "" || trusted.Login != actor.Login {
		return fail("DHF_SCOPE_DENIED"), nil
	}
	attempts, err := store.DHFPilotRecentAttestationAuthFailures(ctx, actor.ID)
	if err != nil {
		return fail("DHF_GATE_REVIEW_UNAVAILABLE"), err
	}
	if attempts >= 5 {
		return fail("DHF_REAUTH_RATE_LIMITED"), nil
	}
	current, hash, err := tx.UserByLogin(ctx, trusted.Login)
	if err != nil || current.ID != actor.ID || current.MustChangePassword ||
		bcrypt.CompareHashAndPassword([]byte(hash), []byte(input.Password)) != nil {
		if err = store.DHFPilotAuditAttestationAuthFailure(ctx, actor.ID, submissionID); err != nil {
			return fail("DHF_GATE_REVIEW_UNAVAILABLE"), err
		}
		if err = tx.Commit(ctx); err != nil {
			return fail("DHF_GATE_REVIEW_UNAVAILABLE"), err
		}
		return fail("DHF_REAUTH_FAILED"), nil
	}
	// All business evidence referenced by a signed candidate must still be
	// available, correctly pinned and accessible to this actual Gate signer.
	candidateStore, ok := any(tx).(ports.DHFPilotGateCandidateStore)
	if !ok || s.blobs == nil {
		return fail("DHF_GATE_EVIDENCE_UNAVAILABLE"), nil
	}
	pins, err := candidateStore.DHFPilotGateEvidenceForSigner(ctx, submissionID, actor.ID)
	if err != nil || len(pins) == 0 {
		return fail("DHF_GATE_EVIDENCE_UNAVAILABLE"), nil
	}
	for _, pin := range pins {
		if _, err = s.visibleFile(ctx, tx, trusted, pin.FileID, domain.ActionPreview); err != nil {
			return fail("DHF_GATE_EVIDENCE_DENIED"), nil
		}
		version, err := tx.VersionBySeq(ctx, pin.FileID, pin.VersionSeq)
		if err != nil || version.BlobID != pin.BlobID || version.Sha256 != pin.Sha256 {
			return fail("DHF_GATE_EVIDENCE_INVALID"), nil
		}
		blob, err := tx.BlobByID(ctx, pin.BlobID)
		if err != nil || blob.State != "ready" || blob.Sha256 != pin.Sha256 ||
			verifyDHFPilotPhysicalBlob(ctx, s.blobs, blob.StorageKey, pin.Sha256, blob.SizeBytes) != nil {
			return fail("DHF_GATE_EVIDENCE_INVALID"), nil
		}
	}
	// Idempotency identifies the unchanged signer intent and signed source,
	// not a later mutable upstream position snapshot. The latter is frozen
	// separately in the first review and its SHA-256 audit.
	requestSHA := hashPilotSubmit(submissionID, actor.ID, input.IdempotencyKey,
		source.Candidate.DecisionPayloadSHA,
		"strict:"+source.Candidate.PolicySHA+":"+source.Candidate.ManifestSHA)
	prev, err := store.DHFStageGateReviewBySubmission(ctx, submissionID)
	if err == nil {
		if prev.SignerID == actor.ID && prev.IdempotencyKey == input.IdempotencyKey &&
			prev.RequestSHA == requestSHA && prev.CandidateID == source.Candidate.ID {
			return DHFStageGateRequestOutcome{ReviewID: prev.ID, SubmissionID: submissionID,
				State: prev.State, Replayed: true, TrialOnly: true}, nil
		}
		return fail("DHF_GATE_REVIEW_ALREADY_REQUESTED"), nil
	}
	if !errors.Is(err, ports.ErrRowMissing) {
		return fail("DHF_GATE_REVIEW_UNAVAILABLE"), err
	}
	record := ports.DHFStageGateReviewRecord{ID: NewID("dhfgatereview"),
		SubmissionID: submissionID, CandidateID: source.Candidate.ID,
		AttemptID: source.Candidate.AttemptID, ProjectID: source.Candidate.ProjectID,
		StageID: source.Candidate.StageID, TemplateID: source.Candidate.TemplateID,
		SignerID: actor.ID, Mode: "strict", State: "awaiting_enterprise_authority",
		PolicySHA: source.Candidate.PolicySHA, ManifestSHA: source.Candidate.ManifestSHA,
		CandidatePayloadSHA: source.Candidate.DecisionPayloadSHA,
		Dependencies:        ready.Dependencies, MissingPreconditions: ready.MissingPreconditions,
		IdempotencyKey: input.IdempotencyKey, RequestSHA: requestSHA, TrialOnly: true}
	if err = store.DHFStageGatePersistReview(ctx, record); err != nil {
		return fail("DHF_GATE_REVIEW_PRECONDITION"), err
	}
	if err = tx.Commit(ctx); err != nil {
		return fail("DHF_GATE_REVIEW_PRECONDITION"), err
	}
	return DHFStageGateRequestOutcome{ReviewID: record.ID, SubmissionID: submissionID,
		State: record.State, TrialOnly: true}, nil
}
