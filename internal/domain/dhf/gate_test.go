package dhf

import (
	"slices"
	"testing"
	"time"
)

var testNow = time.Date(2026, 10, 24, 13, 0, 0, 0, time.UTC)

func baseInput(action Action) GateInput {
	p := PolicySnapshot{
		TemplateVersionID: "template-v1",
		TemplateHash: "policy-sha",
		StageID: "G5",
		Published: true,
		Requirements: []RequirementPolicy{
			{ID: "SW", SpecialtyKey: "G5-SW", Mandatory: true, Critical: true},
			{ID: "MF", SpecialtyKey: "G5-MF", Mandatory: true, Critical: true},
		},
		Specialties: []SpecialtyPolicy{
			{Key: "G5-SW"},
			{Key: "G5-MF"},
		},
	}
	s := StageSnapshot{
		ProjectID: "proj", StageID: "G5", AttemptID: "attempt-1",
		TemplateVersionID: "template-v1", TemplateHash: "policy-sha",
		EvidenceManifestHash: "evidence-sha", State: Reviewing,
		ActorAuthorized: true, SeparationValid: true,
		FileReleaseApproved: true, BaselineActive: true,
		Now: testNow,
	}
	return GateInput{
		Action: action, Policy: p, Stage: s,
		Requirements: []RequirementResult{
			{ID: "SW", Applicability: Applicable, EvidenceBound: true, EvidenceVerified: true},
			{ID: "MF", Applicability: Applicable, EvidenceBound: true, EvidenceVerified: true},
		},
		Specialties: []SpecialtyReview{
			{Key: "G5-SW", AttemptID: "attempt-1", TemplateHash: "policy-sha",
				EvidenceManifestHash: "evidence-sha", Applicability: Applicable, Decision: SpecialtyApproved, Authorized: true},
			{Key: "G5-MF", AttemptID: "attempt-1", TemplateHash: "policy-sha",
				EvidenceManifestHash: "evidence-sha", Applicability: Applicable, Decision: SpecialtyApproved, Authorized: true},
		},
	}
}

func expect(t *testing.T, actual Decision, want Verdict, reason string) {
	t.Helper()
	if actual.Verdict != want {
		t.Fatalf("got %s, want %s; reasons=%v", actual.Verdict, want, actual.Reasons)
	}
	if reason != "" && !slices.Contains(actual.Reasons, reason) {
		t.Fatalf("missing reason %q in %v", reason, actual.Reasons)
	}
	if !slices.IsSorted(actual.Reasons) || len(actual.Reasons) != len(slices.Compact(slices.Clone(actual.Reasons))) {
		t.Fatalf("reason codes must be sorted and unique: %v", actual.Reasons)
	}
}

func TestG5CompleteFinalDecision(t *testing.T) {
	in := baseInput(ActionFinalize)
	expect(t, Evaluate(in), Allow, "")
}

func TestUnpublishedAndInactiveBaselineRejected(t *testing.T) {
	in := baseInput(ActionFinalize)
	in.Policy.Published = false
	expect(t, Evaluate(in), Deny, "DHF_POLICY_UNPUBLISHED")
	in.Policy.Published = true
	in.Stage.BaselineActive = false
	expect(t, Evaluate(in), Deny, "DHF_BASELINE_INACTIVE")
}

func TestMissingOrMismatchedIdentityRejected(t *testing.T) {
	in := baseInput(ActionFinalize)
	in.Stage.TemplateHash = "other-policy"
	expect(t, Evaluate(in), Deny, "DHF_SNAPSHOT_IDENTITY_INVALID")
	in = baseInput(ActionFinalize)
	in.Stage.EvidenceManifestHash = ""
	expect(t, Evaluate(in), Deny, "DHF_SNAPSHOT_IDENTITY_INVALID")
	in = baseInput(ActionFinalize)
	in.Stage.StageID = "G6"
	expect(t, Evaluate(in), Deny, "DHF_SNAPSHOT_IDENTITY_INVALID")
}

func TestPolicyCannotOmitExpectedRequirements(t *testing.T) {
	in := baseInput(ActionFinalize)
	in.Requirements = in.Requirements[:1]
	expect(t, Evaluate(in), Deny, "DHF_REQUIREMENT_SET_INCOMPLETE")
	in = baseInput(ActionFinalize)
	in.Requirements[1].ID = "UNEXPECTED"
	expect(t, Evaluate(in), Deny, "DHF_REQUIREMENT_SET_INVALID")
	in = baseInput(ActionFinalize)
	in.Requirements = append(in.Requirements, in.Requirements[0])
	expect(t, Evaluate(in), Deny, "DHF_REQUIREMENT_SET_INVALID")
	in = baseInput(ActionFinalize)
	in.Policy.Requirements[1].ID = "SW"
	expect(t, Evaluate(in), Deny, "DHF_POLICY_REQUIREMENTS_INVALID")
}

func TestMissingOrExtraDependencyFactsRejected(t *testing.T) {
	in := baseInput(ActionSubmit)
	in.Stage.State = Preparing
	in.Specialties = nil
	in.Policy.Dependencies = []DependencyPolicy{{ID: "G4-submit", PredecessorStage: "G4", GuardedAction: ActionSubmit}}
	expect(t, Evaluate(in), Deny, "DHF_DEPENDENCY_SET_INCOMPLETE")
	in.Dependencies = []DependencyResult{{ID: "G4-submit", PredecessorStage: "G4", State: Accepted}}
	expect(t, Evaluate(in), Allow, "")
	in.Dependencies[0].PredecessorStage = "G1"
	expect(t, Evaluate(in), Deny, "DHF_DEPENDENCY_SET_INVALID")
	in = baseInput(ActionSubmit)
	in.Stage.State = Preparing
	in.Specialties = nil
	in.Dependencies = []DependencyResult{{ID: "unknown", PredecessorStage: "G1", State: Accepted}}
	expect(t, Evaluate(in), Deny, "DHF_DEPENDENCY_SET_INVALID")
}

func TestPreparingHonorsExplicitTemplateDependencies(t *testing.T) {
	in := baseInput(ActionPrepare)
	in.Stage.State = Preparing
	in.Specialties = nil
	in.Policy.Dependencies = []DependencyPolicy{{ID: "G4-prep", PredecessorStage: "G4", GuardedAction: ActionPrepare}}
	in.Dependencies = []DependencyResult{{ID: "G4-prep", PredecessorStage: "G4", State: Preparing}}
	expect(t, Evaluate(in), Deny, "DHF_UPSTREAM_BLOCKED")
	in.Dependencies[0].State = Accepted
	expect(t, Evaluate(in), Allow, "")
}

func TestDraftMayPrepareWithPendingEvidence(t *testing.T) {
	in := baseInput(ActionPrepare)
	in.Stage.State = Preparing
	in.Specialties = nil
	in.Requirements[0].Applicability = ApplicabilityPending
	in.Requirements[0].EvidenceBound = false
	expect(t, Evaluate(in), Allow, "")
	in.Action = ActionSubmit
	expect(t, Evaluate(in), Deny, "DHF_APPLICABILITY_PENDING")
}

func TestStrictStageActionMatrix(t *testing.T) {
	for _, tc := range []struct {
		action Action
		state StageState
		allow bool
	}{
		{ActionPrepare, Preparing, true},
		{ActionPrepare, ChangesRequested, true},
		{ActionPrepare, Accepted, false},
		{ActionPrepare, StageState("unknown"), false},
		{ActionSubmit, Preparing, true},
		{ActionSubmit, Reviewing, false},
		{ActionConditionalApprove, Reviewing, true},
		{ActionConditionalApprove, Accepted, false},
		{ActionFinalize, Reviewing, true},
		{ActionFinalize, ConditionallyReleased, true},
		{ActionFinalize, Submitted, false},
		{ActionIssueDocument, Accepted, true},
		{ActionIssueDocument, ConditionallyReleased, false},
	} {
		in := baseInput(tc.action)
		in.Stage.State = tc.state
		if tc.action == ActionPrepare || tc.action == ActionSubmit || tc.action == ActionIssueDocument {
			in.Specialties = nil
		}
		if tc.action == ActionConditionalApprove {
			// Valid state is not sufficient: a conditional grant is still required.
			tc.allow = false
		}
		got := Evaluate(in)
		if tc.allow {
			expect(t, got, Allow, "")
		} else {
			expect(t, got, Deny, "")
		}
	}
	in := baseInput(Action("unknown_action"))
	expect(t, Evaluate(in), Deny, "DHF_ACTION_UNKNOWN")
}

func TestG5RequiresEverySpecialtyAtFinalization(t *testing.T) {
	in := baseInput(ActionFinalize)
	in.Specialties = in.Specialties[:1]
	expect(t, Evaluate(in), Deny, "DHF_SPECIALTY_SET_INCOMPLETE")
	in = baseInput(ActionFinalize)
	in.Specialties[1].Decision = SpecialtyReturned
	expect(t, Evaluate(in), Deny, "DHF_SPECIALTY_RETURNED")
	in = baseInput(ActionFinalize)
	in.Specialties[1].Authorized = false
	expect(t, Evaluate(in), Deny, "DHF_SPECIALTY_UNAUTHORIZED")
}

func TestG5ReviewMustMatchSameAttemptAndEvidence(t *testing.T) {
	in := baseInput(ActionFinalize)
	in.Specialties[0].AttemptID = "old-attempt"
	expect(t, Evaluate(in), Deny, "DHF_SPECIALTY_REVIEW_INVALID")
	in = baseInput(ActionFinalize)
	in.Specialties[0].EvidenceManifestHash = "old-evidence"
	expect(t, Evaluate(in), Deny, "DHF_SPECIALTY_REVIEW_INVALID")
	in = baseInput(ActionFinalize)
	in.Specialties[0].TemplateHash = "old-policy"
	expect(t, Evaluate(in), Deny, "DHF_SPECIALTY_REVIEW_INVALID")
}

func TestG5InitialSubmitDoesNotRequireFutureSpecialtyReviews(t *testing.T) {
	in := baseInput(ActionSubmit)
	in.Stage.State = Preparing
	in.Specialties = nil
	expect(t, Evaluate(in), Allow, "")
}

func TestG5PolicyCannotBeDisabledByCallerFlag(t *testing.T) {
	in := baseInput(ActionFinalize)
	in.Policy.Specialties = nil
	expect(t, Evaluate(in), Deny, "DHF_SPECIALTY_POLICY_INVALID")
	in = baseInput(ActionFinalize)
	in.Policy.StageID = "G6"
	in.Stage.StageID = "G6"
	expect(t, Evaluate(in), Deny, "DHF_SPECIALTY_POLICY_INVALID")
}

func TestNotApplicableRequiresPolicyAndDecisionAuthorization(t *testing.T) {
	in := baseInput(ActionFinalize)
	in.Requirements[0].Applicability = NotApplicable
	in.Requirements[0].ApplicabilityAuthorized = true
	expect(t, Evaluate(in), Deny, "DHF_APPLICABILITY_UNAUTHORIZED")
	in.Policy.Requirements[0].AllowNotApplicable = true
	in.Specialties[0].Applicability = NotApplicable
	in.Specialties[0].Decision = SpecialtyNotApplicable
	in.Policy.Specialties[0].AllowNotApplicable = true
	expect(t, Evaluate(in), Allow, "")
	in.Specialties[0].Authorized = false
	expect(t, Evaluate(in), Deny, "DHF_SPECIALTY_UNAUTHORIZED")
}

func conditionalInput() GateInput {
	in := baseInput(ActionConditionalApprove)
	in.Policy.ConditionalAllowed = true
	in.Policy.Requirements[0].Critical = false
	in.Policy.Requirements[0].ConditionEligible = true
	in.Requirements[0].EvidenceVerified = false
	in.Specialties[0].Decision = SpecialtyConditional
	in.Remediations = []Remediation{{
		ID: "rem-SW", RequirementID: "SW", AttemptID: "attempt-1",
		State: RemediationOpen, Authorized: true, DueAt: testNow.Add(48 * time.Hour),
	}}
	in.Conditional = &ConditionalPermission{
		DecisionAuthorized: true, ExpiresAt: testNow.Add(24 * time.Hour),
		AllowedActions: []Action{ActionPrepare}, RemediationIDs: []string{"rem-SW"},
	}
	return in
}

func TestConditionalWithBoundRemediationIsLimited(t *testing.T) {
	in := conditionalInput()
	got := Evaluate(in)
	expect(t, got, LimitedAllow, "")
	if !slices.Equal(got.AuthorizedActions, []Action{ActionPrepare}) || !got.ExpiresAt.Equal(testNow.Add(24*time.Hour)) {
		t.Fatalf("limited decision loses scope or expiry: %+v", got)
	}
}

func TestConditionalRequirementMustLinkExactRemediation(t *testing.T) {
	in := conditionalInput()
	in.Remediations[0].RequirementID = "MF"
	expect(t, Evaluate(in), Deny, "DHF_CONDITIONAL_REMEDIATION_MISSING")
	in = conditionalInput()
	in.Remediations[0].AttemptID = "old-attempt"
	expect(t, Evaluate(in), Deny, "DHF_REMEDIATION_INVALID")
	in = conditionalInput()
	in.Conditional.RemediationIDs[0] = "nonexistent"
	expect(t, Evaluate(in), Deny, "DHF_CONDITIONAL_REMEDIATION_INVALID")
	in = conditionalInput()
	in.Remediations[0].DueAt = testNow
	expect(t, Evaluate(in), Deny, "DHF_CONDITIONAL_REMEDIATION_INVALID")
	in = conditionalInput()
	in.Remediations[0].Authorized = false
	expect(t, Evaluate(in), Deny, "DHF_CONDITIONAL_REMEDIATION_INVALID")
}

func TestConditionalRejectsCriticalGapAndUnsafeScope(t *testing.T) {
	in := conditionalInput()
	in.Policy.Requirements[0].Critical = true
	in.Policy.Requirements[0].ConditionEligible = false
	expect(t, Evaluate(in), Deny, "DHF_EVIDENCE_MISSING")
	in = conditionalInput()
	in.Conditional.AllowedActions = []Action{ActionFinalize}
	expect(t, Evaluate(in), Deny, "DHF_CONDITIONAL_SCOPE_UNSAFE")
	in = conditionalInput()
	in.Conditional.AllowedActions = []Action{ActionIssueDocument}
	expect(t, Evaluate(in), Deny, "DHF_CONDITIONAL_SCOPE_UNSAFE")
	in = conditionalInput()
	in.Conditional.ExpiresAt = testNow
	expect(t, Evaluate(in), Deny, "DHF_CONDITIONAL_EXPIRED")
	in = conditionalInput()
	in.Policy.ConditionalAllowed = false
	expect(t, Evaluate(in), Deny, "DHF_CONDITIONAL_UNAUTHORIZED")
}

func TestConditionalSpecialtyCannotMasqueradeAsFullyApproved(t *testing.T) {
	in := conditionalInput()
	in.Specialties[0].Decision = SpecialtyApproved
	expect(t, Evaluate(in), Deny, "DHF_SPECIALTY_PENDING")
	in = conditionalInput()
	in.Specialties[1].Decision = SpecialtyConditional
	expect(t, Evaluate(in), Deny, "DHF_SPECIALTY_PENDING")
}

func TestClosedRemediationAndFreshEvidenceAllowFinalization(t *testing.T) {
	in := baseInput(ActionFinalize)
	in.Stage.State = ConditionallyReleased
	in.Remediations = []Remediation{{
		ID: "rem-SW", RequirementID: "SW", AttemptID: "attempt-1",
		State: RemediationClosed, ClosureVerified: true,
		Authorized: true, DueAt: testNow.Add(24 * time.Hour),
	}}
	expect(t, Evaluate(in), Allow, "")
	in.Remediations[0].ClosureVerified = false
	expect(t, Evaluate(in), Deny, "DHF_REMEDIATION_UNVERIFIED")
	in.Remediations[0].ClosureVerified = true
	in.Remediations[0].State = RemediationOpen
	expect(t, Evaluate(in), Deny, "DHF_REMEDIATION_OPEN")
}

func TestConditionalPredecessorScopedDirectAndUnexpired(t *testing.T) {
	in := baseInput(ActionSubmit)
	in.Policy.StageID = "G7"
	in.Policy.Specialties = nil
	for idx := range in.Policy.Requirements { in.Policy.Requirements[idx].SpecialtyKey = "" }
	in.Stage.StageID = "G7"
	in.Stage.State = Preparing
	in.Specialties = nil
	in.Policy.Dependencies = []DependencyPolicy{{
		ID: "G6-G7", PredecessorStage: "G6", GuardedAction: ActionSubmit, AllowConditional: true,
	}}
	in.Dependencies = []DependencyResult{{
		ID: "G6-G7", PredecessorStage: "G6", State: ConditionallyReleased,
		Grant: &UpstreamGrant{ID: "grant", TargetStageID: "G7", Direct: true, Authorized: true,
			ExpiresAt: testNow.Add(time.Hour), AllowedActions: []Action{ActionSubmit}},
	}}
	expect(t, Evaluate(in), LimitedAllow, "")
	in.Dependencies[0].Grant.InheritedFromID = "another-grant"
	expect(t, Evaluate(in), Deny, "DHF_UPSTREAM_BLOCKED")
	in.Dependencies[0].Grant.InheritedFromID = ""
	in.Dependencies[0].Grant.ExpiresAt = testNow
	expect(t, Evaluate(in), Deny, "DHF_UPSTREAM_BLOCKED")
	in.Dependencies[0].Grant.ExpiresAt = testNow.Add(time.Hour)
	in.Dependencies[0].Grant.AllowedActions = []Action{ActionFinalize}
	expect(t, Evaluate(in), Deny, "DHF_UPSTREAM_BLOCKED")
	in.Dependencies[0].Grant.AllowedActions = []Action{ActionSubmit}
	in.Policy.Dependencies[0].AllowConditional = false
	expect(t, Evaluate(in), Deny, "DHF_UPSTREAM_BLOCKED")
}

func TestConditionalPredecessorCannotAuthorizeFinalization(t *testing.T) {
	in := baseInput(ActionFinalize)
	in.Policy.Dependencies = []DependencyPolicy{{
		ID: "G4-final", PredecessorStage: "G4", GuardedAction: ActionFinalize,
		AllowConditional: true,
	}}
	in.Dependencies = []DependencyResult{{ID: "G4-final", PredecessorStage: "G4",
		State: ConditionallyReleased,
		Grant: &UpstreamGrant{ID: "grant", TargetStageID: "G5", Direct: true, Authorized: true,
			ExpiresAt: testNow.Add(time.Hour), AllowedActions: []Action{ActionFinalize}},
	}}
	expect(t, Evaluate(in), Deny, "DHF_POLICY_DEPENDENCIES_INVALID")
}

func TestFormalIssueRequiresAcceptedStageAndIndependentRelease(t *testing.T) {
	in := baseInput(ActionIssueDocument)
	in.Specialties = nil
	in.Stage.State = Accepted
	expect(t, Evaluate(in), Allow, "")
	in.Stage.FileReleaseApproved = false
	expect(t, Evaluate(in), Deny, "DHF_RELEASE_POLICY_DENIED")
	in.Stage.FileReleaseApproved = true
	in.Stage.State = ConditionallyReleased
	expect(t, Evaluate(in), Deny, "DHF_STATE_INVALID")
}

func TestSecurityScopeAndSeparation(t *testing.T) {
	in := baseInput(ActionFinalize)
	in.Stage.ActorAuthorized = false
	expect(t, Evaluate(in), Deny, "DHF_SCOPE_DENIED")
	in.Stage.ActorAuthorized = true
	in.Stage.SeparationValid = false
	expect(t, Evaluate(in), Deny, "DHF_SELF_REVIEW_DENIED")
}


func TestSpecialtyNotApplicableNeedsAllLinkedRequirementsNotApplicable(t *testing.T) {
	in := baseInput(ActionFinalize)
	in.Policy.Specialties[0].AllowNotApplicable = true
	in.Policy.Requirements[0].AllowNotApplicable = true
	in.Specialties[0].Applicability = NotApplicable
	in.Specialties[0].Decision = SpecialtyNotApplicable
	expect(t, Evaluate(in), Deny, "DHF_SPECIALTY_PENDING")
	in.Requirements[0].Applicability = NotApplicable
	in.Requirements[0].ApplicabilityAuthorized = true
	expect(t, Evaluate(in), Allow, "")
}

func TestConditionalExpiryCannotOutliveRemediationDeadline(t *testing.T) {
	in := conditionalInput()
	in.Conditional.ExpiresAt = testNow.Add(72 * time.Hour)
	expect(t, Evaluate(in), Deny, "DHF_CONDITIONAL_REMEDIATION_MISSING")
	in.Conditional.ExpiresAt = testNow.Add(24 * time.Hour)
	expect(t, Evaluate(in), LimitedAllow, "")
}

func TestEachMissingRequirementNeedsItsOwnRemediationBinding(t *testing.T) {
	in := conditionalInput()
	in.Policy.Requirements[1].Critical = false
	in.Policy.Requirements[1].ConditionEligible = true
	in.Requirements[1].EvidenceBound = false
	in.Specialties[1].Decision = SpecialtyConditional
	expect(t, Evaluate(in), Deny, "DHF_CONDITIONAL_REMEDIATION_MISSING")
	in.Remediations = append(in.Remediations, Remediation{
		ID: "rem-MF", RequirementID: "MF", AttemptID: "attempt-1",
		State: RemediationOpen, Authorized: true, DueAt: testNow.Add(48 * time.Hour),
	})
	in.Conditional.RemediationIDs = append(in.Conditional.RemediationIDs, "rem-MF")
	expect(t, Evaluate(in), LimitedAllow, "")
}

func TestUnknownStageAndEmptyPolicyAreRejected(t *testing.T) {
	in := baseInput(ActionFinalize)
	in.Policy.StageID, in.Stage.StageID = "G10", "G10"
	expect(t, Evaluate(in), Deny, "DHF_SNAPSHOT_IDENTITY_INVALID")
	in = baseInput(ActionFinalize)
	in.Policy.Requirements = nil
	in.Requirements = nil
	expect(t, Evaluate(in), Deny, "DHF_POLICY_REQUIREMENTS_INVALID")
}

func TestFinalizedReviewWithOpenRemediationCannotPass(t *testing.T) {
	in := baseInput(ActionFinalize)
	in.Remediations = []Remediation{{
		ID: "rem1", RequirementID: "SW", AttemptID: "attempt-1",
		State: RemediationOpen, Authorized: true, DueAt: testNow.Add(24 * time.Hour),
	}}
	expect(t, Evaluate(in), Deny, "DHF_REMEDIATION_OPEN")
}


func TestUnexpectedDependencyStateDeniedEvenWhenGuardingAnotherAction(t *testing.T) {
	in := baseInput(ActionFinalize)
	in.Policy.Dependencies = []DependencyPolicy{{ID: "G4-prep", PredecessorStage: "G4", GuardedAction: ActionPrepare}}
	in.Dependencies = []DependencyResult{{ID: "G4-prep", PredecessorStage: "G4", State: StageState("invalid")}}
	expect(t, Evaluate(in), Deny, "DHF_DEPENDENCY_SET_INVALID")
}

func TestOptionalOrCriticalRequirementsCannotBeConditionEligible(t *testing.T) {
	in := baseInput(ActionFinalize)
	in.Policy.Requirements[0].ConditionEligible = true
	expect(t, Evaluate(in), Deny, "DHF_POLICY_REQUIREMENTS_INVALID")
	in.Policy.Requirements[0].Critical = false
	in.Policy.Requirements[0].Mandatory = false
	expect(t, Evaluate(in), Deny, "DHF_POLICY_REQUIREMENTS_INVALID")
}

func TestUnapprovedRemediationNeverCountsAsClosed(t *testing.T) {
	in := baseInput(ActionFinalize)
	in.Remediations = []Remediation{{
		ID: "rm", RequirementID: "SW", AttemptID: "attempt-1", State: RemediationClosed,
		ClosureVerified: true, Authorized: false, DueAt: testNow.Add(time.Hour),
	}}
	expect(t, Evaluate(in), Deny, "DHF_REMEDIATION_INVALID")
}
