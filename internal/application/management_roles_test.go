package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"testing"
	"time"
)

func TestP2AuditorHasOnlyReadAuditCapability(t *testing.T) {
	s, repo := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	auditor := domain.User{ID: "u_user"}
	if _, err := s.ListPermissionAudit(ctx, auditor, "", 10); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("baseline access: %v", err)
	}
	if _, err := s.CreateRoleBinding(ctx, auditor, RoleBindingDraft{UserID: "u_user", Role: "auditor"}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non-admin cannot assign role: %v", err)
	}
	if _, err := s.CreateRoleBinding(ctx, admin, RoleBindingDraft{UserID: admin.ID, Role: "auditor"}); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("self-binding blocked: %v", err)
	}
	b, err := s.CreateRoleBinding(ctx, admin, RoleBindingDraft{UserID: auditor.ID, Role: "auditor"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ListPermissionAudit(ctx, auditor, "", 10); err != nil {
		t.Fatalf("auditor cannot read audit: %v", err)
	}
	if _, err = s.ListGrants(ctx, auditor, "folder_market"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("auditor must not see ACL: %v", err)
	}
	if _, err = s.CreateGrant(ctx, auditor, "folder_market", GrantRequest{
		SubjectKind: "user", SubjectID: admin.ID, Actions: []domain.Action{domain.ActionList}, ScopeOnly: true,
	}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("auditor escalated ACL: %v", err)
	}
	fileActions, err := s.resolveActions(ctx, repo, auditor, "folder_market")
	if err != nil || len(fileActions) != 0 {
		t.Fatalf("auditor must not gain file rights: %+v err=%v", fileActions, err)
	}
	if err = s.RevokeRoleBinding(ctx, admin, b.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ListPermissionAudit(ctx, auditor, "", 10); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("revoked auditor must lose audit access immediately: %v", err)
	}
}

func TestP2PermissionManagerScopedAndNoSelfElevation(t *testing.T) {
	s, repo := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	manager := domain.User{ID: "u_user"}
	repo.seedUser(domain.User{ID: "u_other", Login: "other", DisplayName: "Other"}, "")
	role, err := s.CreateRoleBinding(ctx, admin, RoleBindingDraft{
		UserID: manager.ID, Role: "permission_admin", ScopeID: "folder_market",
		AllowedActions: []domain.Action{domain.ActionList, domain.ActionPreview},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ListGrants(ctx, manager, "folder_market"); err != nil {
		t.Fatalf("should read in-scope ACL: %v", err)
	}
	if _, err = s.ListGrants(ctx, manager, "folder_root"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("out of scope access: %v", err)
	}
	denied := []struct {
		folder string
		req    GrantRequest
	}{
		{"folder_root", GrantRequest{SubjectKind: "user", SubjectID: "u_other", Actions: []domain.Action{domain.ActionList}, ScopeOnly: true}},
		{"folder_market", GrantRequest{SubjectKind: "user", SubjectID: "u_other", Actions: []domain.Action{domain.ActionDownload}, ScopeOnly: true}},
		{"folder_market", GrantRequest{SubjectKind: "user", SubjectID: manager.ID, Actions: []domain.Action{domain.ActionList}, ScopeOnly: true}},
		{"folder_market", GrantRequest{SubjectKind: "user", SubjectID: "u_other", Actions: []domain.Action{domain.ActionList}, ScopeOnly: false}},
	}
	for i, tc := range denied {
		if _, err = s.CreateGrant(ctx, manager, tc.folder, tc.req); !errors.Is(err, domain.ErrForbidden) {
			t.Fatalf("delegation bypass %d: %v", i, err)
		}
	}
	granted, err := s.CreateGrant(ctx, manager, "folder_market", GrantRequest{
		SubjectKind: "user", SubjectID: "u_other", Actions: []domain.Action{domain.ActionList}, ScopeOnly: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateGrant(ctx, manager, "folder_market", GrantRequest{
		SubjectKind: "user", SubjectID: "u_other", Actions: []domain.Action{domain.ActionUpload}, ScopeOnly: true,
	}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("out-of-cap action: %v", err)
	}
	if err = s.RevokeRoleBinding(ctx, admin, role.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ListGrants(ctx, manager, "folder_market"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("revoked manager still able to read grants: %v", err)
	}
	if err = s.RevokeGrant(ctx, manager, granted.ID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("revoked manager still able to mutate: %v", err)
	}
	// Role management must not silently change the manager's file ACL actions.
	actual, err := s.resolveActions(ctx, repo, manager, "folder_market")
	if err != nil || len(actual) != 0 {
		t.Fatalf("role management is independent of file access: %+v %v", actual, err)
	}
}

func TestP2RoleExpiryAndWorkgroupSelfGrant(t *testing.T) {
	s, repo := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	manager := domain.User{ID: "u_user"}
	group, err := s.CreateWorkgroup(ctx, admin, "delegation-group", "")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.AddWorkgroupMember(ctx, admin, group.ID, manager.ID); err != nil {
		t.Fatal(err)
	}
	expires := s.now().Add(time.Hour)
	if _, err = s.CreateRoleBinding(ctx, admin, RoleBindingDraft{
		UserID: manager.ID, Role: "permission_admin", ScopeID: "folder_market",
		AllowedActions: []domain.Action{domain.ActionList}, ExpiresAt: &expires,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateGrant(ctx, manager, "folder_market", GrantRequest{
		SubjectKind: "group", SubjectID: group.ID, Actions: []domain.Action{domain.ActionList},
		ScopeOnly: true, ExpiresAt: &expires,
	}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("group self-grant must be blocked: %v", err)
	}
	if _, err = s.CreateGrant(ctx, manager, "folder_market", GrantRequest{
		SubjectKind: "user", SubjectID: admin.ID, Actions: []domain.Action{domain.ActionList},
		ScopeOnly: true,
	}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("unbounded grant from expiring role: %v", err)
	}
	_ = repo
}
