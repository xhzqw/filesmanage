package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"time"
)

type RoleBindingDraft struct {
	UserID         string
	Role           string
	ScopeID        string
	AllowedActions []domain.Action
	ExpiresAt      *time.Time
}

// Only system admins delegate management capabilities. A delegated manager
// must never further delegate them, or gain ordinary file read permissions.
func (s *Service) CreateRoleBinding(ctx context.Context, actor domain.User, draft RoleBindingDraft) (domain.ManagementRoleBinding, error) {
	if !actor.IsAdmin {
		return domain.ManagementRoleBinding{}, domain.ErrForbidden
	}
	if draft.UserID == "" || draft.UserID == actor.ID || len(draft.UserID) > 128 {
		return domain.ManagementRoleBinding{}, domain.ErrInvalidInput
	}
	if draft.ExpiresAt != nil && !draft.ExpiresAt.After(s.now()) {
		return domain.ManagementRoleBinding{}, domain.ErrInvalidInput
	}
	b := domain.ManagementRoleBinding{
		ID: NewID("mrole"), UserID: draft.UserID, Role: draft.Role,
		AllowedActions: append([]domain.Action{}, draft.AllowedActions...),
		ExpiresAt:      draft.ExpiresAt, GrantedBy: actor.ID, CreatedAt: s.now().UTC(),
	}
	switch b.Role {
	case "auditor":
		if draft.ScopeID != "" || len(b.AllowedActions) != 0 {
			return domain.ManagementRoleBinding{}, domain.ErrInvalidInput
		}
		b.ScopeKind = "global"
	case "permission_admin":
		if draft.ScopeID == "" || len(b.AllowedActions) == 0 || len(b.AllowedActions) > 9 {
			return domain.ManagementRoleBinding{}, domain.ErrInvalidInput
		}
		for _, a := range b.AllowedActions {
			if !domain.AllowedAction(a) {
				return domain.ManagementRoleBinding{}, domain.ErrInvalidInput
			}
		}
		b.ScopeKind = "folder"
		b.ScopeID = draft.ScopeID
	default:
		return domain.ManagementRoleBinding{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.ManagementRoleBinding{}, err
	}
	defer tx.Rollback(ctx)
	subject, err := tx.UserByID(ctx, draft.UserID)
	if err != nil {
		return domain.ManagementRoleBinding{}, notFoundOr(err)
	}
	if subject.IsAdmin || subject.DisabledAt != nil {
		return domain.ManagementRoleBinding{}, domain.ErrInvalidInput
	}
	if b.Role == "permission_admin" {
		if _, err = s.activeFolder(ctx, tx, b.ScopeID); err != nil {
			return domain.ManagementRoleBinding{}, err
		}
	}
	if err = tx.InsertRoleBinding(ctx, b); err != nil {
		return domain.ManagementRoleBinding{}, mapError(err)
	}
	if err = auditRequired(ctx, tx, actor, "role.assign", "user", b.UserID, "success",
		map[string]any{"before": nil, "after": roleAuditState(b)}); err != nil {
		return domain.ManagementRoleBinding{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.ManagementRoleBinding{}, err
	}
	s.bumpACLEpoch()
	return b, nil
}

func roleAuditState(b domain.ManagementRoleBinding) map[string]any {
	return map[string]any{"roleBindingId": b.ID, "role": b.Role, "scopeKind": b.ScopeKind,
		"scopeId": b.ScopeID, "allowedActions": actionNames(b.AllowedActions), "expiresAt": b.ExpiresAt,
		"userId": b.UserID}
}

func (s *Service) RevokeRoleBinding(ctx context.Context, actor domain.User, id string) error {
	if !actor.IsAdmin {
		return domain.ErrForbidden
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	b, err := tx.RoleBindingByID(ctx, id)
	if err != nil {
		return notFoundOr(err)
	}
	if err = tx.RevokeRoleBinding(ctx, id); err != nil {
		return mapError(err)
	}
	if err = auditRequired(ctx, tx, actor, "role.revoke", "user", b.UserID, "success",
		map[string]any{"before": roleAuditState(b), "after": nil}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.bumpACLEpoch()
	return nil
}

func (s *Service) ListRoleBindings(ctx context.Context, actor domain.User) ([]domain.ManagementRoleBinding, error) {
	if !actor.IsAdmin {
		return nil, domain.ErrForbidden
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	return tx.ListRoleBindings(ctx)
}

func (s *Service) MyRoleBindings(ctx context.Context, actor domain.User) ([]domain.ManagementRoleBinding, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.RoleBindingsForUser(ctx, actor.ID)
	if err != nil {
		return nil, err
	}
	out := make([]domain.ManagementRoleBinding, 0, len(rows))
	for _, b := range rows {
		if b.Active(s.now()) {
			out = append(out, b)
		}
	}
	return out, nil
}

func (s *Service) hasAuditPermission(ctx context.Context, repo ports.Repository, actor domain.User) (bool, error) {
	if actor.IsAdmin {
		return true, nil
	}
	bindings, err := repo.RoleBindingsForUser(ctx, actor.ID)
	if err != nil {
		return false, err
	}
	for _, b := range bindings {
		if b.Role == "auditor" && b.ScopeKind == "global" && b.Active(s.now()) {
			return true, nil
		}
	}
	return false, nil
}

// An ACL delegation is limited to ONE bound folder, a subset of delegated
// file actions, and never extends beyond the binding's expiry.
func (s *Service) canManageFolderACL(ctx context.Context, repo ports.Repository, actor domain.User,
	folderID string, actions []domain.Action, grantExpiry *time.Time) (bool, error) {
	if actor.IsAdmin {
		return true, nil
	}
	bindings, err := repo.RoleBindingsForUser(ctx, actor.ID)
	if err != nil {
		return false, err
	}
	for _, b := range bindings {
		if b.Role != "permission_admin" || b.ScopeKind != "folder" || b.ScopeID != folderID || !b.Active(s.now()) {
			continue
		}
		if len(actions) > 0 && b.ExpiresAt != nil && (grantExpiry == nil || grantExpiry.After(*b.ExpiresAt)) {
			continue
		}
		allowed := map[domain.Action]bool{}
		for _, a := range b.AllowedActions {
			allowed[a] = true
		}
		valid := true
		for _, a := range actions {
			if !allowed[a] {
				valid = false
				break
			}
		}
		if valid {
			return true, nil
		}
	}
	return false, nil
}

func (s *Service) blocksSelfGrant(ctx context.Context, repo ports.Repository, actor domain.User,
	subjectKind, subjectID string) (bool, error) {
	if subjectKind == "user" {
		return subjectID == actor.ID, nil
	}
	groups, err := repo.WorkgroupsOf(ctx, actor.ID)
	if err != nil {
		return false, err
	}
	for _, id := range groups {
		if id == subjectID {
			return true, nil
		}
	}
	return false, nil
}
