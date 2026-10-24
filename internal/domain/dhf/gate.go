// Package dhf evaluates Stage Gate policy snapshots without side effects.
//
// This is a controlled pilot, NOT an authorization endpoint. The application
// layer must load the immutable, approved policy and current project facts
// inside a write transaction; callers must never copy policy or authority
// flags from HTTP input. An Allow here is necessary, never sufficient.
package dhf

import (
	"slices"
	"sort"
	"time"
)

type Action string

const (
	ActionPrepare            Action = "prepare"
	ActionSubmit             Action = "submit"
	ActionConditionalApprove Action = "conditional_approve"
	ActionFinalize           Action = "finalize"
	ActionIssueDocument      Action = "issue_document"
)

type StageState string

const (
	Preparing             StageState = "preparing"
	Submitted             StageState = "submitted"
	Reviewing             StageState = "reviewing"
	ChangesRequested      StageState = "changes_requested"
	ConditionallyReleased StageState = "conditionally_released"
	Accepted              StageState = "accepted"
	Cancelled             StageState = "cancelled"
)

type Verdict string

const (
	Allow        Verdict = "allow"
	LimitedAllow Verdict = "limited_allow"
	Deny         Verdict = "deny"
)

type Applicability string

const (
	ApplicabilityPending Applicability = "pending"
	Applicable           Applicability = "applicable"
	NotApplicable        Applicability = "not_applicable"
)

type SpecialtyDecision string

const (
	SpecialtyPending       SpecialtyDecision = "pending"
	SpecialtyApproved      SpecialtyDecision = "approved"
	SpecialtyConditional   SpecialtyDecision = "conditional_recommended"
	SpecialtyReturned      SpecialtyDecision = "returned"
	SpecialtyNotApplicable SpecialtyDecision = "not_applicable"
)

type RemediationState string

const (
	RemediationOpen   RemediationState = "open"
	RemediationClosed RemediationState = "closed"
)

// PolicySnapshot is the COMPLETE set of rules for one published stage,
// not a per-command selection. Application code must verify its provenance,
// published revision/hash and applicable template-to-project baseline.
type PolicySnapshot struct {
	TemplateVersionID string
	TemplateHash      string
	StageID           string
	Published         bool
	ConditionalAllowed bool
	Requirements      []RequirementPolicy
	Dependencies      []DependencyPolicy
	Specialties       []SpecialtyPolicy
}

type RequirementPolicy struct {
	ID                 string
	SpecialtyKey       string // empty means stage-level/shared
	Mandatory          bool
	Critical           bool
	ConditionEligible  bool
	AllowNotApplicable bool
}

type DependencyPolicy struct {
	ID               string
	PredecessorStage string
	GuardedAction    Action
	AllowConditional bool // only prepare/submit grants can be considered
}

type SpecialtyPolicy struct {
	Key                string
	AllowNotApplicable bool
}

// StageSnapshot is a consistent, server-verified view of the current attempt.
// AttemptID is allocated when preparing starts, before a formal submission.
type StageSnapshot struct {
	ProjectID          string
	StageID            string
	AttemptID          string
	TemplateVersionID  string
	TemplateHash       string
	EvidenceManifestHash string
	State              StageState
	ActorAuthorized    bool
	SeparationValid    bool
	FileReleaseApproved bool // CDW still MUST independently authorize issuance
	BaselineActive     bool
	Now                time.Time
}

type RequirementResult struct {
	ID                      string
	Applicability           Applicability
	ApplicabilityAuthorized bool
	EvidenceBound           bool
	EvidenceVerified        bool // includes exact (file_id, seq, sha256) check
}

// A direct conditional predecessor grant never delegates further authority.
// Application verifies the grant's signer, version, target and revocation.
type UpstreamGrant struct {
	ID                 string
	TargetStageID      string
	Direct             bool
	Authorized         bool
	InheritedFromID    string
	ExpiresAt          time.Time
	AllowedActions     []Action
}

type DependencyResult struct {
	ID                string
	PredecessorStage  string
	State             StageState
	Grant             *UpstreamGrant
}

type SpecialtyReview struct {
	Key                 string
	AttemptID           string
	TemplateHash        string
	EvidenceManifestHash string
	Applicability       Applicability
	Decision            SpecialtyDecision
	Authorized          bool
}

// One verified remediation obligation per missing requirement, linked to this
// attempt. Overall counts cannot establish identity or coverage.
type Remediation struct {
	ID               string
	RequirementID    string
	AttemptID        string
	State            RemediationState
	Authorized       bool
	DueAt            time.Time
	ClosureVerified  bool
}

type ConditionalPermission struct {
	DecisionAuthorized bool
	ExpiresAt          time.Time
	AllowedActions     []Action
	RemediationIDs     []string // exact per-requirement obligations
}

type GateInput struct {
	Action       Action
	Policy       PolicySnapshot
	Stage        StageSnapshot
	Requirements []RequirementResult
	Dependencies []DependencyResult
	Specialties  []SpecialtyReview
	Remediations []Remediation
	Conditional  *ConditionalPermission
}

type Decision struct {
	Verdict            Verdict
	Reasons            []string // stable, opaque reason codes
	AuthorizedActions  []Action // populated ONLY on limited authorization
	ExpiresAt          time.Time
}

func decision(verdict Verdict, reasons ...string) Decision {
	sort.Strings(reasons)
	return Decision{Verdict: verdict, Reasons: slices.Compact(reasons)}
}

func validAction(action Action) bool {
	switch action {
	case ActionPrepare, ActionSubmit, ActionConditionalApprove, ActionFinalize, ActionIssueDocument:
		return true
	}
	return false
}

func validStageID(id string) bool {
	switch id {
	case "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9":
		return true
	}
	return false
}

func validState(state StageState) bool {
	switch state {
	case Preparing, Submitted, Reviewing, ChangesRequested, ConditionallyReleased, Accepted, Cancelled:
		return true
	}
	return false
}

func stateAllows(action Action, state StageState) bool {
	switch action {
	case ActionPrepare, ActionSubmit:
		return state == Preparing || state == ChangesRequested
	case ActionConditionalApprove:
		return state == Reviewing
	case ActionFinalize:
		return state == Reviewing || state == ConditionallyReleased
	case ActionIssueDocument:
		return state == Accepted
	}
	return false
}

func safeConditionalActions(actions []Action) bool {
	if len(actions) == 0 {
		return false
	}
	for _, action := range actions {
		if action != ActionPrepare && action != ActionSubmit {
			return false
		}
	}
	return true
}

func uniqueActions(actions []Action) []Action {
	set := map[Action]bool{}
	for _, action := range actions {
		set[action] = true
	}
	result := make([]Action, 0, len(set))
	for action := range set {
		result = append(result, action)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

// A specialty can be marked not applicable only when ALL its linked
// requirements received individually authorized N/A determinations.
func specialtyRequirementsNotApplicable(key string, rules []RequirementPolicy, results map[string]RequirementResult) bool {
	found := false
	for _, rule := range rules {
		if rule.SpecialtyKey != key {
			continue
		}
		found = true
		result, ok := results[rule.ID]
		if !ok || !rule.AllowNotApplicable || result.Applicability != NotApplicable || !result.ApplicabilityAuthorized {
			return false
		}
	}
	return found
}

// Evaluate checks set completeness, identity and rules using trusted facts.
// It cannot cryptographically prove that the template came from the database;
// authoritative construction and locking remain mandatory at integration.
func Evaluate(in GateInput) Decision {
	var reasons []string
	add := func(code string) { reasons = append(reasons, code) }
	p, s := in.Policy, in.Stage

	if !validAction(in.Action) {
		return decision(Deny, "DHF_ACTION_UNKNOWN")
	}
	if !validState(s.State) || !stateAllows(in.Action, s.State) {
		add("DHF_STATE_INVALID")
	}
	if !validStageID(p.StageID) || p.TemplateVersionID == "" || p.TemplateHash == "" ||
		s.ProjectID == "" || s.AttemptID == "" || s.EvidenceManifestHash == "" ||
		p.StageID != s.StageID || p.TemplateVersionID != s.TemplateVersionID ||
		p.TemplateHash != s.TemplateHash {
		add("DHF_SNAPSHOT_IDENTITY_INVALID")
	}
	if !p.Published {
		add("DHF_POLICY_UNPUBLISHED")
	}
	if !s.BaselineActive {
		add("DHF_BASELINE_INACTIVE")
	}
	if !s.ActorAuthorized {
		add("DHF_SCOPE_DENIED")
	}
	if (in.Action == ActionConditionalApprove || in.Action == ActionFinalize) && !s.SeparationValid {
		add("DHF_SELF_REVIEW_DENIED")
	}
	if in.Action == ActionIssueDocument && !s.FileReleaseApproved {
		add("DHF_RELEASE_POLICY_DENIED")
	}
	if s.Now.IsZero() {
		add("DHF_TIME_MISSING")
	}

	// The complete, authoritative policy defines the expected sets.
	// Duplicates and missing/extra results are blocking rather than ignored.
	requirements := make(map[string]RequirementPolicy, len(p.Requirements))
	for _, req := range p.Requirements {
		if req.ID == "" || (req.ConditionEligible && (!req.Mandatory || req.Critical)) {
			add("DHF_POLICY_REQUIREMENTS_INVALID")
		}
		if _, exists := requirements[req.ID]; exists {
			add("DHF_POLICY_REQUIREMENTS_INVALID")
		}
		requirements[req.ID] = req
	}
	if len(requirements) == 0 {
		add("DHF_POLICY_REQUIREMENTS_INVALID")
	}
	results := make(map[string]RequirementResult, len(in.Requirements))
	for _, got := range in.Requirements {
		if got.ID == "" {
			add("DHF_REQUIREMENT_SET_INVALID")
		}
		if _, exists := results[got.ID]; exists {
			add("DHF_REQUIREMENT_SET_INVALID")
		}
		results[got.ID] = got
		if _, expected := requirements[got.ID]; !expected {
			add("DHF_REQUIREMENT_SET_INVALID")
		}
	}
	if len(results) != len(requirements) {
		add("DHF_REQUIREMENT_SET_INCOMPLETE")
	}
	for id := range requirements {
		if _, found := results[id]; !found {
			add("DHF_REQUIREMENT_SET_INCOMPLETE")
		}
	}

	// Every template dependency must appear in the evaluation input, including
	// those not guarded by the current action, so caller-side filtering cannot
	// silently remove a blocking edge.
	depPolicies := make(map[string]DependencyPolicy, len(p.Dependencies))
	for _, dep := range p.Dependencies {
		if dep.ID == "" || dep.PredecessorStage == "" || dep.PredecessorStage == p.StageID ||
			!validAction(dep.GuardedAction) || (dep.AllowConditional && dep.GuardedAction != ActionPrepare && dep.GuardedAction != ActionSubmit) {
			add("DHF_POLICY_DEPENDENCIES_INVALID")
		}
		if _, exists := depPolicies[dep.ID]; exists {
			add("DHF_POLICY_DEPENDENCIES_INVALID")
		}
		depPolicies[dep.ID] = dep
	}
	depResults := make(map[string]DependencyResult, len(in.Dependencies))
	for _, dep := range in.Dependencies {
		if dep.ID == "" || !validState(dep.State) {
			add("DHF_DEPENDENCY_SET_INVALID")
		}
		if _, exists := depResults[dep.ID]; exists {
			add("DHF_DEPENDENCY_SET_INVALID")
		}
		depResults[dep.ID] = dep
		if rule, found := depPolicies[dep.ID]; !found || rule.PredecessorStage != dep.PredecessorStage {
			add("DHF_DEPENDENCY_SET_INVALID")
		}
	}
	if len(depPolicies) != len(depResults) {
		add("DHF_DEPENDENCY_SET_INCOMPLETE")
	}
	for id := range depPolicies {
		if _, found := depResults[id]; !found {
			add("DHF_DEPENDENCY_SET_INCOMPLETE")
		}
	}

	specialties := make(map[string]SpecialtyPolicy, len(p.Specialties))
	for _, spec := range p.Specialties {
		if spec.Key == "" {
			add("DHF_SPECIALTY_POLICY_INVALID")
		}
		if _, exists := specialties[spec.Key]; exists {
			add("DHF_SPECIALTY_POLICY_INVALID")
		}
		specialties[spec.Key] = spec
	}
	if p.StageID == "G5" && len(specialties) == 0 {
		add("DHF_SPECIALTY_POLICY_INVALID")
	}
	if p.StageID != "G5" && len(specialties) != 0 {
		add("DHF_SPECIALTY_POLICY_INVALID")
	}
	for _, req := range p.Requirements {
		if req.SpecialtyKey != "" {
			if _, exists := specialties[req.SpecialtyKey]; !exists {
				add("DHF_SPECIALTY_POLICY_INVALID")
			}
		}
	}

	// Requirement readiness: prepare remains a reversible drafting operation.
	// Submit and final decisions require complete applicability/evidence;
	// only an explicitly scoped conditional decision can defer a noncritical
	// missing item, and even then it must bind a live remediation.
	remediations := make(map[string]Remediation, len(in.Remediations))
	openByRequirement := map[string][]Remediation{}
	for _, r := range in.Remediations {
		if r.ID == "" || r.RequirementID == "" || r.AttemptID != s.AttemptID ||
			!r.Authorized || r.DueAt.IsZero() {
			add("DHF_REMEDIATION_INVALID")
		}
		if _, exists := remediations[r.ID]; exists {
			add("DHF_REMEDIATION_INVALID")
		}
		if _, exists := requirements[r.RequirementID]; !exists {
			add("DHF_REMEDIATION_INVALID")
		}
		if r.State != RemediationOpen && r.State != RemediationClosed {
			add("DHF_REMEDIATION_INVALID")
		}
		if r.State == RemediationClosed && !r.ClosureVerified {
			add("DHF_REMEDIATION_UNVERIFIED")
		}
		remediations[r.ID] = r
		if r.State == RemediationOpen {
			openByRequirement[r.RequirementID] = append(openByRequirement[r.RequirementID], r)
		}
	}
	if in.Action == ActionFinalize {
		for _, r := range in.Remediations {
			if r.State != RemediationClosed || !r.ClosureVerified {
				add("DHF_REMEDIATION_OPEN")
			}
		}
	}

	missing := map[string]RequirementPolicy{}
	for _, policy := range p.Requirements {
		got, ok := results[policy.ID]
		if !ok {
			continue
		}
		switch got.Applicability {
		case ApplicabilityPending:
			if in.Action != ActionPrepare {
				add("DHF_APPLICABILITY_PENDING")
			}
			continue
		case NotApplicable:
			if !policy.AllowNotApplicable || !got.ApplicabilityAuthorized {
				add("DHF_APPLICABILITY_UNAUTHORIZED")
			}
			continue
		case Applicable:
		default:
			add("DHF_APPLICABILITY_INVALID")
			continue
		}
		if in.Action == ActionPrepare || !policy.Mandatory {
			continue
		}
		if got.EvidenceBound && got.EvidenceVerified {
			continue
		}
		missing[policy.ID] = policy
	}

	var allowed []Action
	var expiry time.Time
	if in.Action == ActionConditionalApprove {
		grant := in.Conditional
		if !p.ConditionalAllowed || grant == nil || !grant.DecisionAuthorized {
			add("DHF_CONDITIONAL_UNAUTHORIZED")
		}
		if grant != nil {
			if !grant.ExpiresAt.After(s.Now) {
				add("DHF_CONDITIONAL_EXPIRED")
			}
			if !safeConditionalActions(grant.AllowedActions) {
				add("DHF_CONDITIONAL_SCOPE_UNSAFE")
			}
			expiry = grant.ExpiresAt
			allowed = uniqueActions(grant.AllowedActions)

			grantRemediations := map[string]bool{}
			for _, id := range grant.RemediationIDs {
				if id == "" || grantRemediations[id] {
					add("DHF_CONDITIONAL_REMEDIATION_INVALID")
				}
				grantRemediations[id] = true
				r, ok := remediations[id]
				if !ok || r.State != RemediationOpen || r.AttemptID != s.AttemptID || !r.Authorized ||
					!r.DueAt.After(s.Now) {
					add("DHF_CONDITIONAL_REMEDIATION_INVALID")
				}
			}
			coveredMissing := map[string]bool{}
			for id, policy := range missing {
				if policy.Critical || !policy.ConditionEligible {
					add("DHF_EVIDENCE_MISSING")
					continue
				}
				found := false
				for _, remedy := range openByRequirement[id] {
					if grantRemediations[remedy.ID] && remedy.Authorized && remedy.DueAt.After(s.Now) &&
						!grant.ExpiresAt.After(remedy.DueAt) {
						found = true
					}
				}
				if !found {
					add("DHF_CONDITIONAL_REMEDIATION_MISSING")
				} else {
					coveredMissing[id] = true
				}
			}
			for id := range grantRemediations {
				if r, ok := remediations[id]; ok && !coveredMissing[r.RequirementID] {
					add("DHF_CONDITIONAL_REMEDIATION_EXTRANEOUS")
				}
			}
		}
		if len(missing) == 0 {
			add("DHF_NO_CONDITIONAL_GAP")
		}
	} else if in.Action != ActionPrepare {
		for range missing {
			add("DHF_EVIDENCE_MISSING")
		}
	}
	if in.Action != ActionConditionalApprove && in.Conditional != nil {
		add("DHF_CONDITIONAL_CONTEXT_UNEXPECTED")
	}

	upstreamLimited := false
	for id, depPolicy := range depPolicies {
		dep, ok := depResults[id]
		if !ok || depPolicy.GuardedAction != in.Action {
			continue
		}
		switch dep.State {
		case Accepted:
			if dep.Grant != nil {
				add("DHF_DEPENDENCY_GRANT_UNEXPECTED")
			}
		case ConditionallyReleased:
			grant := dep.Grant
			if !depPolicy.AllowConditional || !safeConditionalActions([]Action{in.Action}) || grant == nil ||
				!grant.Direct || !grant.Authorized || grant.ID == "" || grant.InheritedFromID != "" ||
				grant.TargetStageID != p.StageID || !grant.ExpiresAt.After(s.Now) ||
				!safeConditionalActions(grant.AllowedActions) || !slices.Contains(grant.AllowedActions, in.Action) {
				add("DHF_UPSTREAM_BLOCKED")
			} else {
				upstreamLimited = true
				if expiry.IsZero() || grant.ExpiresAt.Before(expiry) {
					expiry = grant.ExpiresAt
				}
				if len(allowed) == 0 {
					allowed = []Action{in.Action}
				} else if !slices.Contains(allowed, in.Action) {
					add("DHF_UPSTREAM_SCOPE_CONFLICT")
				}
			}
		default:
			add("DHF_UPSTREAM_BLOCKED")
		}
	}

	// A stage review is only valid against the same frozen attempt and
	// evidence manifest. A conditional recommendation is NOT approval.
	if (in.Action == ActionFinalize || in.Action == ActionConditionalApprove) && p.StageID == "G5" {
		seen := map[string]bool{}
		missingSpecialties := map[string]bool{}
		for _, policy := range missing {
			if policy.SpecialtyKey != "" {
				missingSpecialties[policy.SpecialtyKey] = true
			}
		}
		for _, review := range in.Specialties {
			rule, ok := specialties[review.Key]
			if !ok || seen[review.Key] || review.AttemptID != s.AttemptID ||
				review.TemplateHash != s.TemplateHash || review.EvidenceManifestHash != s.EvidenceManifestHash {
				add("DHF_SPECIALTY_REVIEW_INVALID")
			}
			seen[review.Key] = true
			if !review.Authorized {
				add("DHF_SPECIALTY_UNAUTHORIZED")
			}
			switch {
			case review.Applicability == Applicable && review.Decision == SpecialtyApproved && !missingSpecialties[review.Key]:
			case review.Applicability == NotApplicable && rule.AllowNotApplicable &&
				review.Decision == SpecialtyNotApplicable && specialtyRequirementsNotApplicable(review.Key, p.Requirements, results):
			case review.Applicability == Applicable && review.Decision == SpecialtyConditional &&
				in.Action == ActionConditionalApprove && missingSpecialties[review.Key]:
			case review.Decision == SpecialtyReturned:
				add("DHF_SPECIALTY_RETURNED")
			default:
				add("DHF_SPECIALTY_PENDING")
			}
		}
		if len(seen) != len(specialties) {
			add("DHF_SPECIALTY_SET_INCOMPLETE")
		}
		for key := range specialties {
			if !seen[key] {
				add("DHF_SPECIALTY_SET_INCOMPLETE")
			}
		}
	} else if len(in.Specialties) != 0 {
		add("DHF_SPECIALTY_CONTEXT_UNEXPECTED")
	}

	if len(reasons) != 0 {
		return decision(Deny, reasons...)
	}
	if in.Action == ActionConditionalApprove || upstreamLimited {
		return Decision{Verdict: LimitedAllow, AuthorizedActions: allowed, ExpiresAt: expiry}
	}
	return decision(Allow)
}
