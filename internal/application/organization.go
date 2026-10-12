package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"golang.org/x/crypto/bcrypt"
	"regexp"
)

// Organization use cases. SPEC §2.1 reserves user/group/department management
// for the system administrator; every entry point enforces it and audits.

func (s *Service) requireAdmin(u domain.User) error {
	if !u.IsAdmin {
		return domain.ErrForbidden
	}
	return nil
}

func (s *Service) ListUsers(ctx context.Context, u domain.User) ([]domain.User, error) {
	if err := s.requireAdmin(u); err != nil {
		return nil, err
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	return tx.ListUsers(ctx)
}

type UserPage struct {
	Items      []domain.User
	NextCursor string
}
type WorkgroupPage struct {
	Items      []domain.Workgroup
	NextCursor string
}

var organizationCursorRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func validateOrganizationPage(cursor string, limit int) error {
	if limit < 1 || limit > 200 || (cursor != "" && !organizationCursorRE.MatchString(cursor)) {
		return domain.ErrInvalidInput
	}
	return nil
}

func (s *Service) PageUsers(ctx context.Context, u domain.User, cursor string, limit int) (UserPage, error) {
	if err := s.requireAdmin(u); err != nil {
		return UserPage{}, err
	}
	if err := validateOrganizationPage(cursor, limit); err != nil {
		return UserPage{}, err
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return UserPage{}, err
	}
	defer tx.Rollback(ctx)
	items, err := tx.PageUsers(ctx, cursor, limit+1)
	if err != nil {
		return UserPage{}, err
	}
	page := UserPage{Items: items}
	if len(items) > limit {
		page.Items = items[:limit]
		page.NextCursor = page.Items[len(page.Items)-1].ID
	}
	return page, nil
}

func (s *Service) PageWorkgroups(ctx context.Context, u domain.User, cursor string, limit int) (WorkgroupPage, error) {
	if err := s.requireAdmin(u); err != nil {
		return WorkgroupPage{}, err
	}
	if err := validateOrganizationPage(cursor, limit); err != nil {
		return WorkgroupPage{}, err
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return WorkgroupPage{}, err
	}
	defer tx.Rollback(ctx)
	items, err := tx.PageWorkgroups(ctx, cursor, limit+1)
	if err != nil {
		return WorkgroupPage{}, err
	}
	page := WorkgroupPage{Items: items}
	if len(items) > limit {
		page.Items = items[:limit]
		page.NextCursor = page.Items[len(page.Items)-1].ID
	}
	return page, nil
}

type UserDraft struct {
	Login        string
	DisplayName  string
	DepartmentID string
	IsAdmin      bool
	Password     string
}

// CreateUser issues a usable credential without mandatory first-login rotation.
func (s *Service) CreateUser(ctx context.Context, actor domain.User, draft UserDraft) (domain.User, error) {
	if err := s.requireAdmin(actor); err != nil {
		return domain.User{}, err
	}
	if len(draft.Login) < 1 || len(draft.Login) > 80 || len(draft.DisplayName) < 1 || len(draft.DisplayName) > 80 {
		return domain.User{}, domain.ErrInvalidInput
	}
	if len(draft.Password) < 16 || len(draft.Password) > 128 {
		return domain.User{}, ErrPasswordPolicy
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(draft.Password), bcrypt.DefaultCost)
	if err != nil {
		return domain.User{}, err
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.User{}, err
	}
	defer tx.Rollback(ctx)
	if draft.DepartmentID != "" {
		departments, listErr := tx.ListDepartments(ctx)
		if listErr != nil {
			return domain.User{}, listErr
		}
		if !departmentExists(departments, draft.DepartmentID) {
			return domain.User{}, domain.ErrInvalidInput
		}
	}
	user := domain.User{
		ID: NewID("u"), Login: draft.Login, DisplayName: draft.DisplayName,
		IsAdmin: draft.IsAdmin, DepartmentID: draft.DepartmentID,
		MustChangePassword: false,
	}
	if err = tx.CreateUser(ctx, user, string(hash)); err != nil {
		return domain.User{}, mapError(err)
	}
	if err = auditRequired(ctx, tx, actor, "user.create", "user", user.ID, "success",
		map[string]any{"before": nil, "after": map[string]any{
			"isAdmin": user.IsAdmin, "departmentId": user.DepartmentID, "mustChangePassword": false,
		}}); err != nil {
		return domain.User{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.User{}, err
	}
	s.notifyWorkspaceChange("organization")
	return user, nil
}

// notFoundOr converts a missing row into the domain 404 sentinel and passes
// real storage failures through untouched.
func notFoundOr(err error) error {
	if errors.Is(err, ports.ErrRowMissing) {
		return domain.ErrNotFound
	}
	return err
}

func departmentExists(departments []domain.Department, id string) bool {
	for _, d := range departments {
		if d.ID == id {
			return true
		}
	}
	return false
}

func (s *Service) SetUserDisabled(ctx context.Context, actor domain.User, userID string, disabled bool) error {
	if err := s.requireAdmin(actor); err != nil {
		return err
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	target, err := tx.UserByID(ctx, userID)
	if err != nil {
		return notFoundOr(err)
	}
	if target.ID == actor.ID && disabled {
		return domain.ErrInvalidInput
	}
	if err = tx.SetUserDisabled(ctx, userID, disabled); err != nil {
		return mapError(err)
	}
	if err = auditRequired(ctx, tx, actor, map[bool]string{true: "user.disable", false: "user.enable"}[disabled],
		"user", userID, "success", map[string]any{
			"before": map[string]any{"disabled": target.DisabledAt != nil},
			"after":  map[string]any{"disabled": disabled},
		}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	// Invalidate only after the database decision is durable.
	s.bumpACLEpoch()
	s.session.dropUser(userID)
	s.notifySessionChange(userID)
	return nil
}

// ResetUserPassword issues a new credential for an account and kills its
// sessions; the new credential can be used immediately.
func (s *Service) ResetUserPassword(ctx context.Context, actor domain.User, userID, newPassword string) error {
	if err := s.requireAdmin(actor); err != nil {
		return err
	}
	if len(newPassword) < 16 || len(newPassword) > 128 {
		return ErrPasswordPolicy
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	target, err := tx.UserByID(ctx, userID)
	if err != nil {
		return notFoundOr(err)
	}
	if err = tx.SetUserPassword(ctx, userID, string(hash)); err != nil {
		return mapError(err)
	}
	if err = auditRequired(ctx, tx, actor, "user.password_reset", "user", userID, "success",
		map[string]any{
			"before": map[string]any{"mustChangePassword": target.MustChangePassword},
			"after":  map[string]any{"mustChangePassword": false, "sessionsRevoked": true},
		}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	// SetUserPassword revokes every server session in the same transaction.
	// Without eviction the session cache can continue authorizing stale tokens.
	s.bumpACLEpoch()
	s.session.dropUser(userID)
	s.notifySessionChange(userID)
	return nil
}

func (s *Service) ListDepartments(ctx context.Context, u domain.User) ([]domain.Department, error) {
	if err := s.requireAdmin(u); err != nil {
		return nil, err
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	return tx.ListDepartments(ctx)
}

func (s *Service) CreateDepartment(ctx context.Context, actor domain.User, name, parentID string) (domain.Department, error) {
	if err := s.requireAdmin(actor); err != nil {
		return domain.Department{}, err
	}
	if len(name) < 1 || len(name) > 80 {
		return domain.Department{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.Department{}, err
	}
	defer tx.Rollback(ctx)
	var parent *string
	if parentID != "" {
		departments, listErr := tx.ListDepartments(ctx)
		if listErr != nil {
			return domain.Department{}, listErr
		}
		if !departmentExists(departments, parentID) {
			return domain.Department{}, domain.ErrNotFound
		}
		parent = &parentID
	}
	department := domain.Department{ID: NewID("dept"), Name: name, ParentID: parent}
	if err = tx.CreateDepartment(ctx, department); err != nil {
		return domain.Department{}, mapError(err)
	}
	audit(ctx, tx, actor, "department.create", "department", department.ID, "success", map[string]any{"name": name})
	if err = tx.Commit(ctx); err != nil {
		return domain.Department{}, err
	}
	s.notifyWorkspaceChange("organization")
	return department, nil
}

func (s *Service) ListWorkgroups(ctx context.Context, u domain.User) ([]domain.Workgroup, error) {
	if err := s.requireAdmin(u); err != nil {
		return nil, err
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	return tx.ListWorkgroups(ctx)
}

func (s *Service) CreateWorkgroup(ctx context.Context, actor domain.User, name, departmentID string) (domain.Workgroup, error) {
	if err := s.requireAdmin(actor); err != nil {
		return domain.Workgroup{}, err
	}
	if len(name) < 1 || len(name) > 80 {
		return domain.Workgroup{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.Workgroup{}, err
	}
	defer tx.Rollback(ctx)
	var department *string
	if departmentID != "" {
		departments, listErr := tx.ListDepartments(ctx)
		if listErr != nil {
			return domain.Workgroup{}, listErr
		}
		if !departmentExists(departments, departmentID) {
			return domain.Workgroup{}, domain.ErrNotFound
		}
		department = &departmentID
	}
	group := domain.Workgroup{ID: NewID("group"), Name: name, DepartmentID: department}
	if err = tx.CreateWorkgroup(ctx, group); err != nil {
		return domain.Workgroup{}, mapError(err)
	}
	audit(ctx, tx, actor, "workgroup.create", "workgroup", group.ID, "success", map[string]any{"name": name})
	if err = tx.Commit(ctx); err != nil {
		return domain.Workgroup{}, err
	}
	s.notifyWorkspaceChange("organization")
	return group, nil
}

func (s *Service) DeleteWorkgroup(ctx context.Context, actor domain.User, groupID string) error {
	if err := s.requireAdmin(actor); err != nil {
		return err
	}
	if groupID == "" {
		return domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	group, err := tx.WorkgroupByID(ctx, groupID)
	if err != nil {
		return notFoundOr(err)
	}
	if err = tx.DeleteWorkgroup(ctx, groupID); err != nil {
		return mapError(err)
	}
	if err = auditRequired(ctx, tx, actor, "workgroup.delete", "workgroup", groupID, "success",
		map[string]any{"name": group.Name, "departmentId": group.DepartmentID, "membersRemoved": "cascade"}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.bumpACLEpoch()
	s.notifyWorkspaceChange("organization")
	s.notifyWorkspaceChange("permissions")
	return nil
}

func (s *Service) WorkgroupMembers(ctx context.Context, actor domain.User, groupID string) ([]domain.User, error) {
	if err := s.requireAdmin(actor); err != nil {
		return nil, err
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.WorkgroupByID(ctx, groupID); err != nil {
		return nil, domain.ErrNotFound
	}
	return tx.WorkgroupMembers(ctx, groupID)
}

func (s *Service) AddWorkgroupMember(ctx context.Context, actor domain.User, groupID, userID string) error {
	if err := s.requireAdmin(actor); err != nil {
		return err
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.WorkgroupByID(ctx, groupID); err != nil {
		return notFoundOr(err)
	}
	_, err = tx.UserByID(ctx, userID)
	if err != nil {
		return notFoundOr(err)
	}
	if err = tx.AddWorkgroupMember(ctx, groupID, userID); err != nil {
		return mapError(err)
	}
	if err = auditRequired(ctx, tx, actor, "workgroup.member_add", "workgroup", groupID, "success",
		map[string]any{"userId": userID, "before": map[string]any{"member": false},
			"after": map[string]any{"member": true}}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.bumpACLEpoch()
	return nil
}

func (s *Service) RemoveWorkgroupMember(ctx context.Context, actor domain.User, groupID, userID string) error {
	if err := s.requireAdmin(actor); err != nil {
		return err
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.WorkgroupByID(ctx, groupID); err != nil {
		return notFoundOr(err)
	}
	if err = tx.RemoveWorkgroupMember(ctx, groupID, userID); err != nil {
		return mapError(err)
	}
	if err = auditRequired(ctx, tx, actor, "workgroup.member_remove", "workgroup", groupID, "success",
		map[string]any{"userId": userID, "before": map[string]any{"member": true},
			"after": map[string]any{"member": false}}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.bumpACLEpoch()
	return nil
}
