package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"golang.org/x/crypto/bcrypt"
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

type UserDraft struct {
	Login        string
	DisplayName  string
	DepartmentID string
	IsAdmin      bool
	Password     string
}

// CreateUser issues a new account. The first login must change the issued
// password (must_change_password defaults true in the schema).
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
		// Schema default: issued credentials must be changed on first login.
		MustChangePassword: true,
	}
	if err = tx.CreateUser(ctx, user, string(hash)); err != nil {
		return domain.User{}, mapError(err)
	}
	audit(ctx, tx, actor, "user.create", "user", user.ID, "success",
		map[string]any{"login": user.Login, "displayName": user.DisplayName, "departmentId": user.DepartmentID, "isAdmin": user.IsAdmin})
	if err = tx.Commit(ctx); err != nil {
		return domain.User{}, err
	}
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
	audit(ctx, tx, actor, map[bool]string{true: "user.disable", false: "user.enable"}[disabled], "user", userID, "success",
		map[string]any{"login": target.Login})
	return tx.Commit(ctx)
}

// ResetUserPassword issues a new credential for an account and kills its
// sessions; the next login must change it again.
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
	if err = tx.ForcePasswordChange(ctx, userID); err != nil {
		return err
	}
	audit(ctx, tx, actor, "user.password_reset", "user", userID, "success", map[string]any{"login": target.Login})
	return tx.Commit(ctx)
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
	return group, nil
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
	target, err := tx.UserByID(ctx, userID)
	if err != nil {
		return notFoundOr(err)
	}
	if err = tx.AddWorkgroupMember(ctx, groupID, userID); err != nil {
		return mapError(err)
	}
	audit(ctx, tx, actor, "workgroup.member_add", "workgroup", groupID, "success",
		map[string]any{"userId": userID, "login": target.Login})
	return tx.Commit(ctx)
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
	audit(ctx, tx, actor, "workgroup.member_remove", "workgroup", groupID, "success", map[string]any{"userId": userID})
	return tx.Commit(ctx)
}
