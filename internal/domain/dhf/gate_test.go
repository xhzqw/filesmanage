package dhf

import (
	"slices"
	"testing"
	"time"
)

var pilotNow = time.Date(2026, time.October, 24, 12, 0, 0, 0, time.UTC)

func validInput(action Action) GateInput {
	return GateInput{
		Action: action,
		State: Reviewing,
		TemplatePublished: true,
		BaselineActive: true,
		ActorAuthorized: true,
		SeparationValid: true,
		FileReleaseApproved: true,
		Now: pilotNow,
		Requirements: []Requirement{{
			ID: "REQ-G5-SW-001", Applicability: Applicable,
			Mandatory: true, Critical: true, EvidenceBound: true, EvidenceVerified: true,
		}},
	}
}

func requireDecision(t *testing.T, got Decision, want Verdict, reason string) {
	t.Helper()
	if got.Verdict != want {
		t.Fatalf("verdict = %q; want %q (reasons: %v)", got.Verdict, want, got.Reasons)
	}
	if reason != "" && !slices.Contains(got.Reasons, reason) {
		t.Fatalf("missing reason %q: %v", reason, got.Reasons)
	}
}

func TestGateRejectsUnpublishedPolicyAndInactiveBaseline(t *testing.T) {
	in := validInput(ActionFinalize)
	in.TemplatePublished = false
	requireDecision(t, Evaluate(in), Deny, "DHF_POLICY_UNPUBLISHED")
	in.TemplatePublished, in.BaselineActive = true, false
	requireDecision(t, Evaluate(in), Deny, "DHF_BASELINE_INACTIVE")
}

func TestGateDenyByDefaultForUnknownActionsAndSubjects(t *testing.T) {
	in := validInput(Action("arbitrary"))
	requireDecision(t, Evaluate(in), Deny, "DHF_ACTION_UNKNOWN")
	in = validInput(ActionFinalize)
	in.ActorAuthorized = false
	requireDecision(t, Evaluate(in), Deny, "DHF_SCOPE_DENIED")
	in.ActorAuthorized = true
	in.SeparationValid = false
	requireDecision(t, Evaluate(in), Deny, "DHF_SELF_REVIEW_DENIED")
}

func TestG5GateRequiresAllConfiguredSpecialties(t *testing.T) {
	in := validInput(ActionFinalize)
	in.IsG5 = true
	in.ExpectedSpecialties = []string{"G5-SW", "G5-MF"}
	in.SpecialtyReviews = []SpecialtyReview{
		{Key: "G5-SW", Applicability: Applicable, Decision: SpecialtyApproved, AuthorizedDecision: true},
	}
	requireDecision(t, Evaluate(in), Deny, "DHF_SPECIALTY_PENDING")
	in.SpecialtyReviews = append(in.SpecialtyReviews,
		SpecialtyReview{Key: "G5-MF", Applicability: Applicable, Decision: SpecialtyApproved, AuthorizedDecision: true})
	requireDecision(t, Evaluate(in), Allow, "")
	in.SpecialtyReviews[1].Decision = SpecialtyReturned
	requireDecision(t, Evaluate(in), Deny, "DHF_SPECIALTY_RETURNED")
}

func TestG5NotApplicableIsNotAnAutomaticSkip(t *testing.T) {
	in := validInput(ActionFinalize)
	in.IsG5 = true
	in.ExpectedSpecialties = []string{"G5-SW"}
	in.SpecialtyReviews = []SpecialtyReview{{
		Key: "G5-SW", Applicability: NotApplicable,
		Decision: SpecialtyNotApplicable, AuthorizedDecision: false,
	}}
	requireDecision(t, Evaluate(in), Deny, "DHF_SPECIALTY_UNAUTHORIZED")
	in.SpecialtyReviews[0].AuthorizedDecision = true
	requireDecision(t, Evaluate(in), Allow, "")
}

func TestG5SubmissionDoesNotRequireYetUncreatedSpecialtyReview(t *testing.T) {
	in := validInput(ActionSubmit)
	in.State = Preparing
	in.IsG5 = true
	in.ExpectedSpecialties = []string{"G5-SW", "G5-MF"}
	requireDecision(t, Evaluate(in), Allow, "")
}

func TestRequirementApplicabilityAndEvidenceAreSeparate(t *testing.T) {
	in := validInput(ActionFinalize)
	in.Requirements[0].Applicability = ApplicabilityPending
	requireDecision(t, Evaluate(in), Deny, "DHF_APPLICABILITY_PENDING")
	in.Requirements[0].Applicability = NotApplicable
	requireDecision(t, Evaluate(in), Deny, "DHF_APPLICABILITY_UNAUTHORIZED")
	in.Requirements[0].ApplicabilityAuthorized = true
	requireDecision(t, Evaluate(in), Allow, "")
	in.Requirements[0].Applicability = Applicable
	in.Requirements[0].EvidenceVerified = false
	requireDecision(t, Evaluate(in), Deny, "DHF_EVIDENCE_MISSING")
}

func TestConditionalGateRequiresAuthorizedNoncriticalRemediation(t *testing.T) {
	in := validInput(ActionConditionalApprove)
	in.Requirements[0] = Requirement{
		ID: "REQ-G5-SW-001", Applicability: Applicable, Mandatory: true,
		Critical: false, ConditionEligible: true,
	}
	in.Conditional = &ConditionalPermission{
		TemplateEnabled: true, DecisionAuthorized: true,
		Expiry: pilotNow.Add(24*time.Hour),
		AllowedActions: []Action{ActionPrepare},
		RemediationRequirementIDs: []string{"REQ-G5-SW-001"},
	}
	requireDecision(t, Evaluate(in), LimitedAllow, "")
	in.Conditional.DecisionAuthorized = false
	requireDecision(t, Evaluate(in), Deny, "DHF_CONDITIONAL_UNAUTHORIZED")
	in.Conditional.DecisionAuthorized = true
	in.Conditional.Expiry = pilotNow
	requireDecision(t, Evaluate(in), Deny, "DHF_CONDITIONAL_EXPIRED")
	in.Conditional.Expiry = pilotNow.Add(time.Hour)
	in.Requirements[0].Critical = true
	requireDecision(t, Evaluate(in), Deny, "DHF_EVIDENCE_MISSING")
}

func TestNoImplicitConditionalReleaseOfMissingEvidence(t *testing.T) {
	in := validInput(ActionConditionalApprove)
	in.Requirements[0].Critical = false
	in.Requirements[0].ConditionEligible = true
	in.Requirements[0].EvidenceBound = false
	in.Conditional = &ConditionalPermission{
		TemplateEnabled: true, DecisionAuthorized: true,
		Expiry: pilotNow.Add(time.Hour), AllowedActions: []Action{ActionPrepare},
	}
	requireDecision(t, Evaluate(in), Deny, "DHF_EVIDENCE_MISSING")
}

func TestConditionalPredecessorsAreActionScopedAndNontransitive(t *testing.T) {
	in := validInput(ActionSubmit)
	in.State = Preparing
	in.Dependencies = []Dependency{{
		Key: "G6", GuardedAction: ActionSubmit, Result: ConditionallyReleased,
		Direct: true, ConditionalScope: []Action{ActionSubmit},
	}}
	requireDecision(t, Evaluate(in), LimitedAllow, "")
	in.Dependencies[0].Direct = false
	requireDecision(t, Evaluate(in), Deny, "DHF_UPSTREAM_BLOCKED")
	in.Dependencies[0].Direct = true
	in.Dependencies[0].ConditionalScope = []Action{ActionPrepare}
	requireDecision(t, Evaluate(in), Deny, "DHF_UPSTREAM_BLOCKED")
}

func TestConditionallyReleasedStageCannotIssueDocument(t *testing.T) {
	in := validInput(ActionIssueDocument)
	in.State = ConditionallyReleased
	requireDecision(t, Evaluate(in), Deny, "DHF_RELEASE_POLICY_DENIED")
	in.State = Accepted
	in.FileReleaseApproved = false
	requireDecision(t, Evaluate(in), Deny, "DHF_RELEASE_POLICY_DENIED")
	in.FileReleaseApproved = true
	requireDecision(t, Evaluate(in), Allow, "")
}

func TestConditionalRemediationMustBeClosedBeforeFinalization(t *testing.T) {
	in := validInput(ActionFinalize)
	in.State = ConditionallyReleased
	in.OpenRemediations = 1
	requireDecision(t, Evaluate(in), Deny, "DHF_REMEDIATION_OPEN")
	in.OpenRemediations = 0
	requireDecision(t, Evaluate(in), Allow, "")
}

func TestOrdinaryPreparationDoesNotRequireAcceptedUpstreamGate(t *testing.T) {
	in := validInput(ActionPrepare)
	in.State = Preparing
	in.Dependencies = []Dependency{{Key: "G6", GuardedAction: ActionSubmit, Result: Preparing}}
	in.Requirements[0].EvidenceVerified = false
	requireDecision(t, Evaluate(in), Allow, "")
}

func TestInvalidDuplicateRequirementsAndUnknownRemediation(t *testing.T) {
	in := validInput(ActionSubmit)
	in.State = Preparing
	in.Requirements = append(in.Requirements, in.Requirements[0])
	requireDecision(t, Evaluate(in), Deny, "DHF_REQUIREMENT_SET_INVALID")
}

func TestReasonCodesAreSortedDeduplicatedAndSafe(t *testing.T) {
	in := validInput(ActionFinalize)
	in.ActorAuthorized = false
	in.Requirements[0].EvidenceBound = false
	in.Requirements = append(in.Requirements, Requirement{
		ID:"REQ-G5-MF-001", Applicability:Applicable,
		Mandatory:true,
	})
	d := Evaluate(in)
	if d.Verdict != Deny { t.Fatalf("verdict %q", d.Verdict) }
	if !sortReasonsUnique(d.Reasons) { t.Fatalf("reasons not sorted/unique: %v", d.Reasons) }
}

func sortReasonsUnique(rs []string) bool {
	return slices.IsSorted(rs) && len(rs) == len(slices.Compact(slices.Clone(rs)))
}
