package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"time"
)

// Grant use cases. Managing AND inspecting other subjects' ACLs requires
// manage_acl (system admin only until scoped delegation is implemented).

func (s *Service) ListGrants(ctx context.Context, u domain.User, folderID string) ([]domain.ACL, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	folder, err := s.activeFolder(ctx, tx, folderID)
	if err != nil {
		return nil, err
	}
	allowed, err := s.canManageFolderACL(ctx, tx, u, folder.ID, nil, nil)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, domain.ErrForbidden
	}
	return tx.ListGrants(ctx, folder.ID)
}

type GrantRequest struct {
	SubjectKind string
	SubjectID   string
	Actions     []domain.Action
	ScopeOnly   bool
	ExpiresAt   *time.Time
}

func (s *Service) CreateGrant(ctx context.Context, u domain.User, folderID string, req GrantRequest) (domain.ACL, error) {
	if len(req.Actions) == 0 || (req.SubjectKind != "user" && req.SubjectKind != "group") || req.SubjectID == "" {
		return domain.ACL{}, domain.ErrInvalidInput
	}
	for _, a := range req.Actions {
		if !domain.AllowedAction(a) {
			return domain.ACL{}, domain.ErrInvalidInput
		}
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.ACL{}, err
	}
	defer tx.Rollback(ctx)
	folder, err := s.activeFolder(ctx, tx, folderID)
	if err != nil {
		return domain.ACL{}, err
	}
	// Delegated managers may only issue direct grants, never inheritable ones.
	if !u.IsAdmin && !req.ScopeOnly {
		return domain.ACL{}, domain.ErrForbidden
	}
	allowed, err := s.canManageFolderACL(ctx, tx, u, folder.ID, req.Actions, req.ExpiresAt)
	if err != nil {
		return domain.ACL{}, err
	}
	if !allowed {
		return domain.ACL{}, domain.ErrForbidden
	}
	if !u.IsAdmin {
		self, err := s.blocksSelfGrant(ctx, tx, u, req.SubjectKind, req.SubjectID)
		if err != nil {
			return domain.ACL{}, err
		}
		if self {
			return domain.ACL{}, domain.ErrForbidden
		}
	}
	if err = s.assertSubjectExists(ctx, tx, req.SubjectKind, req.SubjectID); err != nil {
		return domain.ACL{}, err
	}
	grant := domain.ACL{
		ID: NewID("acl"), FolderID: folder.ID, SubjectKind: req.SubjectKind, SubjectID: req.SubjectID,
		Actions: req.Actions, ScopeOnly: req.ScopeOnly, GrantedBy: u.ID,
	}
	if req.ExpiresAt != nil {
		grant.ExpiresAt = req.ExpiresAt
	}
	if err = tx.InsertGrant(ctx, grant); err != nil {
		return domain.ACL{}, mapError(err)
	}
	if err = auditRequired(ctx, tx, u, "acl.create", "folder", folder.ID, "success",
		map[string]any{"before": nil, "after": grantAuditState(grant)}); err != nil {
		return domain.ACL{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.ACL{}, err
	}
	// Authorisation just changed: drop every cached read so the next
	// request sees the new scope (PE04).
	s.bumpACLEpoch()

	return grant, nil
}

func (s *Service) RevokeGrant(ctx context.Context, u domain.User, grantID string) error {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	grant, err := tx.GrantByID(ctx, grantID)
	if err != nil {
		return domain.ErrNotFound
	}
	if !u.IsAdmin && !grant.ScopeOnly {
		return domain.ErrForbidden
	}
	allowed, err := s.canManageFolderACL(ctx, tx, u, grant.FolderID, grant.Actions, grant.ExpiresAt)
	if err != nil {
		return err
	}
	if !allowed {
		return domain.ErrForbidden
	}
	if err = tx.DeleteGrant(ctx, grantID); err != nil {
		return mapError(err)
	}
	if err = auditRequired(ctx, tx, u, "acl.revoke", "folder", grant.FolderID, "success",
		map[string]any{"before": grantAuditState(grant), "after": nil}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	// Never invalidate before an uncommitted revocation becomes visible.
	s.bumpACLEpoch()
	return nil
}

func (s *Service) assertSubjectExists(ctx context.Context, repo domainSubjectProbe, kind, id string) error {
	switch kind {
	case "user":
		found, err := repo.UserExists(ctx, id)
		if err != nil {
			return err
		}
		if !found {
			return domain.ErrInvalidInput
		}
	case "group":
		found, err := repo.WorkgroupExists(ctx, id)
		if err != nil {
			return err
		}
		if !found {
			return domain.ErrInvalidInput
		}
	default:
		return domain.ErrInvalidInput
	}
	return nil
}

type domainSubjectProbe interface {
	UserExists(context.Context, string) (bool, error)
	WorkgroupExists(context.Context, string) (bool, error)
}

func actionNames(actions []domain.Action) []string {
	out := make([]string, 0, len(actions))
	for _, a := range actions {
		out = append(out, string(a))
	}
	return out
}

var _ = errors.Is
