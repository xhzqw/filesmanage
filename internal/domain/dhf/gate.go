// Package dhf contains policy-only, fail-closed Stage Gate calculations.
//
// V0.6 controlled pilot: no HTTP route, persistence, or production approval
// operation calls this package yet. All inputs MUST be resolved server-side
// from a signed template version, frozen evidence and effective actor grants.
// Never construct GateInput directly from untrusted browser booleans.
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
	SpecialtyReturned      SpecialtyDecision = "returned"
	SpecialtyNotApplicable SpecialtyDecision = "not_applicable"
)

type Requirement struct {
	ID                       string
	Applicability            Applicability
	ApplicabilityAuthorized  bool
	Mandatory                bool
	Critical                 bool
	ConditionEligible        bool // approved template policy, not an operator toggle
	EvidenceBound            bool
	EvidenceVerified         bool
}

type SpecialtyReview struct {
	Key                  string
	Applicability        Applicability
	Decision             SpecialtyDecision
	AuthorizedDecision   bool
}

type Dependency struct {
	Key              string
	GuardedAction    Action
	Result           StageState
	Direct           bool
	ConditionalScope []Action // from approved predecessor authorization
	ConditionalValid bool
	ConditionalExpiresAt time.Time
}

type ConditionalPermission struct {
	TemplateEnabled       bool
	DecisionAuthorized    bool
	Expiry                time.Time
	AllowedActions        []Action
	RemediationRequirementIDs []string
}

// GateInput is a *trusted evaluation snapshot*, not an HTTP request type.
// File ACL, duty separation, policy signatures, approval-chain authority and
// evidence hashes are checked by the future application service first.
type GateInput struct {
	Action              Action
	State               StageState
	TemplatePublished   bool
	BaselineActive      bool
	ActorAuthorized     bool
	SeparationValid     bool
	FileReleaseApproved bool
	Now                 time.Time
	Requirements        []Requirement
	IsG5                bool
	ExpectedSpecialties []string // authoritative, signed template snapshot
	SpecialtyReviews    []SpecialtyReview
	Dependencies        []Dependency
	Conditional         *ConditionalPermission
	OpenRemediations    int
}

type Decision struct {
	Verdict Verdict
	Reasons []string // stable opaque reason codes; no sensitive file names
}

func decision(verdict Verdict, reasons ...string) Decision {
	sort.Strings(reasons)
	return Decision{Verdict: verdict, Reasons: slices.Compact(reasons)}
}

func inScope(action Action, allowed []Action) bool {
	return slices.Contains(allowed, action)
}

func conditionalActionsSafe(actions []Action) bool {
	for _, action := range actions {
		if action != ActionPrepare && action != ActionSubmit {
			return false
		}
	}
	return true
}

// Evaluate is deterministic and side-effect free. "allow" is never sufficient
// to authorize a command on its own; the application must re-evaluate in its
// write transaction after locking the authoritative resources.
func Evaluate(in GateInput) Decision {
	switch in.Action {
	case ActionPrepare, ActionSubmit, ActionConditionalApprove, ActionFinalize, ActionIssueDocument:
	default:
		return decision(Deny, "DHF_ACTION_UNKNOWN")
	}
	var reasons []string
	add := func(reason string) { reasons = append(reasons, reason) }

	if !in.TemplatePublished {
		add("DHF_POLICY_UNPUBLISHED")
	}
	if !in.BaselineActive {
		add("DHF_BASELINE_INACTIVE")
	}
	if !in.ActorAuthorized {
		add("DHF_SCOPE_DENIED")
	}
	if in.Action == ActionConditionalApprove || in.Action == ActionFinalize {
		if !in.SeparationValid {
			add("DHF_SELF_REVIEW_DENIED")
		}
	}
	switch in.Action {
	case ActionSubmit:
		if in.State != Preparing && in.State != ChangesRequested {
			add("DHF_STATE_INVALID")
		}
	case ActionConditionalApprove:
		if in.State != Reviewing {
			add("DHF_STATE_INVALID")
		}
	case ActionFinalize:
		if in.State != Reviewing && in.State != ConditionallyReleased {
			add("DHF_STATE_INVALID")
		}
		if in.OpenRemediations != 0 {
			add("DHF_REMEDIATION_OPEN")
		}
	case ActionIssueDocument:
		if in.State != Accepted || !in.FileReleaseApproved {
			add("DHF_RELEASE_POLICY_DENIED")
		}
	case ActionPrepare:
		if in.State == Cancelled {
			add("DHF_STATE_INVALID")
		}
	}

	// Preparing ordinary drafts does not require a formally accepted upstream
	// Gate or complete evidence; it still requires active authorization.
	if in.Action == ActionPrepare {
		if len(reasons) > 0 {
			return decision(Deny, reasons...)
		}
		return decision(Allow)
	}

	// All required signed-template predecessor constraints are checked against
	// the exact guarded action. Conditional grants never propagate transitively.
	upstreamLimited := false
	for _, dep := range in.Dependencies {
		if dep.GuardedAction != in.Action {
			continue
		}
		switch dep.Result {
		case Accepted:
		case ConditionallyReleased:
			if !dep.Direct || !dep.ConditionalValid || in.Now.IsZero() || !dep.ConditionalExpiresAt.After(in.Now) || !inScope(in.Action, dep.ConditionalScope) || in.Action == ActionIssueDocument {
				add("DHF_UPSTREAM_BLOCKED")
			} else {
				upstreamLimited = true
			}
		default:
			add("DHF_UPSTREAM_BLOCKED")
		}
	}

	// Nonapplicable mandatory requirements still need an authorized,
	// recorded applicability decision. Missing critical evidence never
	// becomes eligible for conditional approval.
	remedySet := map[string]bool{}
	grant := in.Conditional
	if grant != nil {
		for _, id := range grant.RemediationRequirementIDs {
			remedySet[id] = true
		}
	}
	if len(in.Requirements) == 0 {
		add("DHF_REQUIREMENT_SET_INVALID")
	}
	missingNoncritical := false
	seenRequirements := map[string]bool{}
	for _, req := range in.Requirements {
		if req.ID == "" || seenRequirements[req.ID] {
			add("DHF_REQUIREMENT_SET_INVALID")
			continue
		}
		seenRequirements[req.ID] = true
		switch req.Applicability {
		case ApplicabilityPending:
			add("DHF_APPLICABILITY_PENDING")
			continue
		case NotApplicable:
			if !req.ApplicabilityAuthorized {
				add("DHF_APPLICABILITY_UNAUTHORIZED")
			}
			continue
		case Applicable:
		default:
			add("DHF_APPLICABILITY_PENDING")
			continue
		}
		if !req.Mandatory || (req.EvidenceBound && req.EvidenceVerified) {
			continue
		}
		if in.Action == ActionConditionalApprove && !req.Critical && req.ConditionEligible && remedySet[req.ID] {
			missingNoncritical = true
		} else {
			add("DHF_EVIDENCE_MISSING")
		}
	}

	if in.IsG5 && (in.Action == ActionFinalize || in.Action == ActionConditionalApprove) {
		if len(in.ExpectedSpecialties) == 0 {
			add("DHF_SPECIALTY_SET_INVALID")
		}
		expected := map[string]bool{}
		for _, key := range in.ExpectedSpecialties {
			if key == "" || expected[key] {
				add("DHF_SPECIALTY_SET_INVALID")
			}
			expected[key] = true
		}
		seen := map[string]bool{}
		for _, review := range in.SpecialtyReviews {
			if !expected[review.Key] || seen[review.Key] {
				add("DHF_SPECIALTY_SET_INVALID")
				continue
			}
			seen[review.Key] = true
			if !review.AuthorizedDecision {
				add("DHF_SPECIALTY_UNAUTHORIZED")
			}
			switch {
			case review.Applicability == Applicable && review.Decision == SpecialtyApproved:
			case review.Applicability == NotApplicable && review.Decision == SpecialtyNotApplicable:
			case review.Applicability == ApplicabilityPending:
				add("DHF_SPECIALTY_PENDING")
			case review.Decision == SpecialtyReturned:
				add("DHF_SPECIALTY_RETURNED")
			default:
				add("DHF_SPECIALTY_PENDING")
			}
		}
		if len(seen) != len(expected) {
			add("DHF_SPECIALTY_PENDING")
		}
	}

	if in.Action == ActionConditionalApprove {
		switch {
		case grant == nil, !grant.TemplateEnabled, !grant.DecisionAuthorized:
			add("DHF_CONDITIONAL_UNAUTHORIZED")
		case in.Now.IsZero() || !grant.Expiry.After(in.Now):
			add("DHF_CONDITIONAL_EXPIRED")
		case len(grant.AllowedActions) == 0:
			add("DHF_CONDITIONAL_SCOPE_EMPTY")
		case !conditionalActionsSafe(grant.AllowedActions):
			add("DHF_CONDITIONAL_SCOPE_UNSAFE")
		}
		if !missingNoncritical {
			add("DHF_NO_CONDITIONAL_REMEDIATION")
		}
		for id := range remedySet {
			if !seenRequirements[id] {
				add("DHF_CONDITIONAL_REMEDIATION_UNKNOWN")
			}
		}
	}
	if len(reasons) > 0 {
		return decision(Deny, reasons...)
	}
	if in.Action == ActionConditionalApprove || upstreamLimited {
		return decision(LimitedAllow)
	}
	return decision(Allow)
}
