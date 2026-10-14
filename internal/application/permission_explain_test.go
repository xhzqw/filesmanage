package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"testing"
)

func TestPermissionExplanationUsesAuthorizationSources(t *testing.T) {
	s, repo := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	member := domain.User{ID: "u_user", Login: "user1"}
	if _, err := s.ExplainFolderPermissions(ctx, member, member.ID, "folder_market"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non-admin must not inspect others' effective rights: %v", err)
	}
	if _, err := s.ExplainFolderPermissions(ctx, admin, member.ID, "folder_missing"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("unknown folder should be hidden: %v", err)
	}
	if _, err := s.ExplainFolderPermissions(ctx, admin, "u_missing", "folder_market"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("unknown subject should be hidden: %v", err)
	}
	empty, err := s.ExplainFolderPermissions(ctx, admin, member.ID, "folder_market")
	if err != nil || len(empty.EffectiveActions) != 0 || len(empty.Sources) != 0 {
		t.Fatalf("default deny explanation: %v %+v", err, empty)
	}
	_, err = s.CreateGrant(ctx, admin, "folder_root", GrantRequest{
		SubjectKind: "user", SubjectID: member.ID,
		Actions: []domain.Action{domain.ActionDownload}, ScopeOnly: true,
	})
	if err != nil { t.Fatal(err) }
	group, err := s.CreateWorkgroup(ctx, admin, "授权解释工作组", "")
	if err != nil { t.Fatal(err) }
	if err = s.AddWorkgroupMember(ctx, admin, group.ID, member.ID); err != nil { t.Fatal(err) }
	_, err = s.CreateGrant(ctx, admin, "folder_root", GrantRequest{
		SubjectKind: "group", SubjectID: group.ID,
		Actions: []domain.Action{domain.ActionPreview},
	})
	if err != nil { t.Fatal(err) }
	_, err = s.CreateGrant(ctx, admin, "folder_market", GrantRequest{
		SubjectKind: "user", SubjectID: member.ID,
		Actions: []domain.Action{domain.ActionDownload},
	})
	if err != nil { t.Fatal(err) }
	_, err = s.CreateShare(ctx, admin, ShareDraft{
		ResourceKind: "folder", ResourceID: "folder_root",
		RecipientKind: "user", RecipientID: member.ID,
		Actions: []domain.Action{domain.ActionList}, IncludeDescendants: true,
	})
	if err != nil { t.Fatal(err) }
	explained, err := s.ExplainFolderPermissions(ctx, admin, member.ID, "folder_market")
	if err != nil { t.Fatal(err) }
	want := []domain.Action{domain.ActionList, domain.ActionPreview, domain.ActionDownload}
	if len(explained.EffectiveActions) != len(want) {
		t.Fatalf("unexpected actions: %+v", explained)
	}
	for i, action := range want {
		if explained.EffectiveActions[i] != action {
			t.Fatalf("decision mismatch at %d: %+v", i, explained)
		}
	}
	found := map[string]bool{}
	for _, source := range explained.Sources {
		if source.Kind == "inherited_acl" && source.SubjectID == member.ID {
			t.Fatal("scope_only ancestor grant must not appear as applied source")
		}
		found[source.Kind] = true
	}
	for _, kind := range []string{"direct_acl", "workgroup_acl", "folder_share"} {
		if !found[kind] { t.Fatalf("missing applied %s: %+v", kind, explained.Sources) }
	}
	actual, err := s.resolveActions(ctx, repo, member, "folder_market")
	if err != nil { t.Fatal(err) }
	for _, a := range actionOrder {
		explainedHas := false
		for _, e := range explained.EffectiveActions { if e == a { explainedHas = true } }
		if actual[a] != explainedHas { t.Fatalf("explained vs actual: %s", a) }
	}
	adminView, err := s.ExplainFolderPermissions(ctx, admin, admin.ID, "folder_market")
	if err != nil || len(adminView.EffectiveActions) != len(actionOrder) ||
		len(adminView.Sources) != 1 || adminView.Sources[0].Kind != "admin_override" {
		t.Fatalf("admin override explanation: %v %+v", err, adminView)
	}
	// Legacy pending flags must not mask real ACLs; disabled state still denies.
	repo.seedUser(domain.User{ID: "u_pending", Login: "pending", MustChangePassword: true}, "")
	if _, err = s.CreateGrant(ctx, admin, "folder_market", GrantRequest{
		SubjectKind: "user", SubjectID: "u_pending", Actions: []domain.Action{domain.ActionList},
	}); err != nil {
		t.Fatal(err)
	}
	pending, err := s.ExplainFolderPermissions(ctx, admin, "u_pending", "folder_market")
	if err != nil || pending.SubjectRequiresPasswordChange ||
		len(pending.EffectiveActions) != 1 || pending.EffectiveActions[0] != domain.ActionList {
		t.Fatalf("legacy password flag must not mask folder grants: %v %+v", err, pending)
	}
	if err = s.SetUserDisabled(ctx, admin, member.ID, true); err != nil {
		t.Fatal(err)
	}
	disabled, err := s.ExplainFolderPermissions(ctx, admin, member.ID, "folder_market")
	if err != nil || !disabled.SubjectDisabled || len(disabled.EffectiveActions) != 0 || len(disabled.Sources) != 0 {
		t.Fatalf("disabled principal has no exercisable rights: %v %+v", err, disabled)
	}
}

func TestPermissionAuditAdminOnlyAndKeyset(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	member := domain.User{ID: "u_user", Login: "user1"}
	if _, err := s.ListPermissionAudit(ctx, member, "", 10); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non-admin audit must be denied: %v", err)
	}
	if _, err := s.ListPermissionAudit(ctx, admin, "-1", 10); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("invalid cursor must be rejected: %v", err)
	}
	if _, err := s.ListPermissionAudit(ctx, admin, "", 101); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("oversized page must be rejected: %v", err)
	}
	for _, a := range []domain.Action{domain.ActionList, domain.ActionDownload, domain.ActionPreview} {
		_, err := s.CreateGrant(ctx, admin, "folder_market", GrantRequest{
			SubjectKind: "user", SubjectID: member.ID, Actions: []domain.Action{a},
		})
		if err != nil { t.Fatal(err) }
	}
	first, err := s.ListPermissionAudit(ctx, admin, "", 2)
	if err != nil || len(first.Items) != 2 || first.NextCursor == "" {
		t.Fatalf("expected first keyset page: %v %+v", err, first)
	}
	second, err := s.ListPermissionAudit(ctx, admin, first.NextCursor, 2)
	if err != nil || len(second.Items) != 1 || second.NextCursor != "" ||
		second.Items[0].ID >= first.Items[1].ID {
		t.Fatalf("expected non-overlapping last page: %v %+v", err, second)
	}
}
