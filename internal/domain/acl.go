package domain

import "time"

// Pure authorization primitives. Database visibility resolution lives in the
// adapter, but the decision rules themselves are domain logic and unit-tested here.

// GrantAppliesToSubject reports whether the grant's subject is the user or one
// of the user's workgroups.
func GrantAppliesToSubject(g ACL, userID string, groupIDs []string) bool {
	switch g.SubjectKind {
	case "user":
		return g.SubjectID == userID
	case "group":
		return containsString(groupIDs, g.SubjectID)
	default:
		return false
	}
}

// GrantCovers reports whether a single grant confers action at time at.
// Expired grants never count.
func GrantCovers(g ACL, action Action, at time.Time) bool {
	if g.ExpiresAt != nil && !g.ExpiresAt.After(at) {
		return false
	}
	return containsAction(g.Actions, action)
}

// ActionsFor unions the actions of every grant that passes subject, expiry and
// scope_only rules. scopeOnlyTarget is true when the folder under evaluation is
// the folder the grants are attached to; inherited grants must not honor
// scope_only entries.
func ActionsFor(grants []ACL, userID string, groupIDs []string, scopeOnlyTarget bool, at time.Time) map[Action]bool {
	out := map[Action]bool{}
	for _, g := range grants {
		if !GrantAppliesToSubject(g, userID, groupIDs) {
			continue
		}
		if g.ScopeOnly && !scopeOnlyTarget {
			continue
		}
		if g.ExpiresAt != nil && !g.ExpiresAt.After(at) {
			continue
		}
		for _, a := range g.Actions {
			if AllowedAction(a) {
				out[a] = true
			}
		}
	}
	return out
}

// AncestorsOf walks parent links upwards from id (inclusive) and rejects cycles
// and runaway depth. parentOf maps folder id -> parent id (nil for root).
func AncestorsOf(parentOf map[string]*string, id string) ([]string, bool) {
	chain := []string{}
	seen := map[string]bool{}
	current := id
	for depth := 0; depth <= 64; depth++ {
		if seen[current] {
			return nil, false
		}
		seen[current] = true
		chain = append(chain, current)
		parent, ok := parentOf[current]
		if !ok || parent == nil {
			return chain, true
		}
		current = *parent
	}
	return nil, false
}

func containsString(values []string, want string) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}

func containsAction(actions []Action, want Action) bool {
	for _, a := range actions {
		if a == want {
			return true
		}
	}
	return false
}
