package domain

import (
	"testing"
	"time"
)

func TestActionsForUnionAndExpiry(t *testing.T) {
	now := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	future := now.Add(time.Hour)
	past := now.Add(-time.Hour)
	grants := []ACL{
		{ID: "g1", SubjectKind: "user", SubjectID: "u1", Actions: []Action{ActionList}},
		{ID: "g2", SubjectKind: "group", SubjectID: "gX", Actions: []Action{ActionUpload}},
		{ID: "g3", SubjectKind: "user", SubjectID: "u1", Actions: []Action{ActionDownload}, ExpiresAt: &past},
		{ID: "g4", SubjectKind: "group", SubjectID: "gX", Actions: []Action{ActionPreview}, ScopeOnly: true},
	}
	actions := ActionsFor(grants, "u1", []string{"gX"}, false, now)
	if !actions[ActionList] || !actions[ActionUpload] {
		t.Fatalf("user and group grants must union: %v", actions)
	}
	if actions[ActionDownload] {
		t.Fatal("expired grant must not count")
	}
	if actions[ActionPreview] {
		t.Fatal("scope_only grant must not apply to inherited folders")
	}
	direct := ActionsFor(grants, "u1", []string{"gX"}, true, now)
	if !direct[ActionPreview] {
		t.Fatal("scope_only grant must apply to the folder it is attached to")
	}
	stranger := ActionsFor(grants, "u2", []string{"gY"}, true, now)
	if len(stranger) != 0 {
		t.Fatalf("unrelated user must get nothing: %v", stranger)
	}
	futureGrants := []ACL{{ID: "g5", SubjectKind: "user", SubjectID: "u1", Actions: []Action{ActionModify}, ExpiresAt: &future}}
	if !ActionsFor(futureGrants, "u1", nil, true, now)[ActionModify] {
		t.Fatal("future expiry must still grant")
	}
}

func TestGrantCovers(t *testing.T) {
	now := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	past := now.Add(-time.Second)
	if !GrantCovers(ACL{Actions: []Action{ActionPrint}}, ActionPrint, now) {
		t.Fatal("matching action must be covered")
	}
	if GrantCovers(ACL{Actions: []Action{ActionPrint}}, ActionList, now) {
		t.Fatal("non-matching action must not be covered")
	}
	if GrantCovers(ACL{Actions: []Action{ActionPrint}, ExpiresAt: &past}, ActionPrint, now) {
		t.Fatal("expired grant must not cover")
	}
}

func TestAncestorsOf(t *testing.T) {
	root := "f_root"
	mid := "f_mid"
	leaf := "f_leaf"
	parentOf := map[string]*string{"f_root": nil, "f_mid": &root, "f_leaf": &mid}
	chain, ok := AncestorsOf(parentOf, leaf)
	if !ok || len(chain) != 3 || chain[0] != leaf || chain[2] != root {
		t.Fatalf("ancestor chain wrong: %v ok=%v", chain, ok)
	}
	self := "f_self"
	cyclic := map[string]*string{"f_self": &self}
	if _, ok := AncestorsOf(cyclic, self); ok {
		t.Fatal("cycle must be rejected")
	}
}
