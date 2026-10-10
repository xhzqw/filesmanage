package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"testing"
)

func TestOrganizationManagementIsAdminOnly(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	user := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()

	if _, err := s.ListUsers(ctx, user); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non-admin user list must be denied: %v", err)
	}
	if _, err := s.CreateUser(ctx, user, UserDraft{Login: "x", DisplayName: "x", Password: "a-very-long-password-1"}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non-admin create must be denied: %v", err)
	}
	if _, err := s.CreateDepartment(ctx, user, "越权部门", ""); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non-admin department create must be denied: %v", err)
	}
	if _, err := s.ListWorkgroups(ctx, user); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non-admin group list must be denied: %v", err)
	}

	if _, err := s.CreateUser(ctx, admin, UserDraft{Login: "weak", DisplayName: "弱口令", Password: "short"}); !errors.Is(err, ErrPasswordPolicy) {
		t.Fatalf("weak issued password must be rejected: %v", err)
	}
	created, err := s.CreateUser(ctx, admin, UserDraft{Login: "clerk01", DisplayName: "市场部文员", Password: "initial-credential-0001"})
	if err != nil {
		t.Fatalf("admin create user failed: %v", err)
	}
	if created.MustChangePassword {
		t.Fatal("new account must be usable without forced password rotation")
	}
	users, err := s.ListUsers(ctx, admin)
	if err != nil || len(users) != 3 {
		t.Fatalf("user list wrong: %v %d", err, len(users))
	}

	if _, err = s.CreateUser(ctx, admin, UserDraft{Login: "clerk01", DisplayName: "重复", Password: "initial-credential-0002"}); !errors.Is(err, domain.ErrNameConflict) {
		t.Fatalf("duplicate login must conflict: %v", err)
	}
	if err = s.SetUserDisabled(ctx, admin, "u_admin", true); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatal("admin must not disable itself")
	}
	if err = s.SetUserDisabled(ctx, admin, created.ID, true); err != nil {
		t.Fatalf("disable failed: %v", err)
	}
	if _, _, err = s.Login(ctx, "clerk01", "initial-credential-0001"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatal("disabled account must not authenticate")
	}
	if err = s.SetUserDisabled(ctx, admin, created.ID, false); err != nil {
		t.Fatalf("enable failed: %v", err)
	}
}

// A password reset must evict a warmed session cache immediately, not only
// revoke the persistent session stored in the repository.
func TestResetUserPasswordRevokesCachedSession(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	token, _, err := s.Login(ctx, "user1", "long-unit-test-password")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Session(ctx, token); err != nil {
		t.Fatal(err)
	}
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	if err := s.ResetUserPassword(ctx, admin, "u_user", "replacement-credential-0001"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Session(ctx, token); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("cached session survived password reset: %v", err)
	}
	_, user, err := s.Login(ctx, "user1", "replacement-credential-0001")
	if err != nil || user.MustChangePassword {
		t.Fatalf("replacement credential must allow normal sign-in: user=%+v err=%v", user, err)
	}
}

func TestWorkgroupMembership(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	group, err := s.CreateWorkgroup(ctx, admin, "验收工作组", "")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.AddWorkgroupMember(ctx, admin, group.ID, "u_user"); err != nil {
		t.Fatalf("add member failed: %v", err)
	}
	if err = s.AddWorkgroupMember(ctx, admin, group.ID, "u_user"); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("duplicate membership must conflict: %v", err)
	}
	if err = s.AddWorkgroupMember(ctx, admin, group.ID, "u_missing"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("unknown member must be rejected: %v", err)
	}
	members, err := s.WorkgroupMembers(ctx, admin, group.ID)
	if err != nil || len(members) != 1 || members[0].ID != "u_user" {
		t.Fatalf("members wrong: %v %+v", err, members)
	}
	if err = s.RemoveWorkgroupMember(ctx, admin, group.ID, "u_user"); err != nil {
		t.Fatalf("remove member failed: %v", err)
	}
	if err = s.RemoveWorkgroupMember(ctx, admin, group.ID, "u_user"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("removing absent member must 404: %v", err)
	}
}

// Group membership must change what a member can see on the next request.
func TestGroupGrantTakesEffectImmediately(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	group, err := s.CreateWorkgroup(ctx, admin, "即时生效组", "")
	if err != nil {
		t.Fatal(err)
	}
	grant, err := s.CreateGrant(ctx, admin, "folder_market", GrantRequest{
		SubjectKind: "group", SubjectID: group.ID, Actions: []domain.Action{domain.ActionList, domain.ActionPreview},
	})
	if err != nil {
		t.Fatal(err)
	}
	user := domain.User{ID: "u_user", Login: "user1"}
	if _, err := s.Folders(ctx, user); err != nil {
		t.Fatal(err)
	}
	visible, err := s.Folders(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if len(visible) != 0 {
		t.Fatalf("non-member must see nothing, got %v", visible)
	}
	if err = s.AddWorkgroupMember(ctx, admin, group.ID, "u_user"); err != nil {
		t.Fatal(err)
	}
	visible, err = s.Folders(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if len(visible) != 1 || visible[0].ID != "folder_market" {
		t.Fatalf("member must see granted folder on next request, got %v", visible)
	}
	if err = s.RemoveWorkgroupMember(ctx, admin, group.ID, "u_user"); err != nil {
		t.Fatal(err)
	}
	visible, err = s.Folders(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if len(visible) != 0 {
		t.Fatalf("removed member must immediately lose grant, got %v", visible)
	}
	if err = s.AddWorkgroupMember(ctx, admin, group.ID, "u_user"); err != nil {
		t.Fatal(err)
	}
	visible, err = s.Folders(ctx, user)
	if err != nil || len(visible) != 1 {
		t.Fatalf("re-added member must regain grant immediately: %v %+v", err, visible)
	}
	if err = s.RevokeGrant(ctx, admin, grant.ID); err != nil {
		t.Fatal(err)
	}
	visible, err = s.Folders(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if len(visible) != 0 {
		t.Fatalf("revoked grant must take effect immediately, got %v", visible)
	}
}
