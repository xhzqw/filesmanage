package application

import (
	"context"
	"filesmanage/internal/domain"
	"golang.org/x/crypto/bcrypt"
)

// RevokeFileMarks removes exactly the selected visible signatures and/or seals
// from a new immutable snapshot. Older marks and revisions remain untouched.
func (s *Service) RevokeFileMarks(ctx context.Context, actor domain.User, id string, seq int, sha string, expected int, markIDs []string, password string) (domain.SealRevision, error) {
	if seq < 1 || expected < 1 || len(sha) != 64 || len(password) > 1024 || len(markIDs) < 1 || len(markIDs) > 120 {
		return domain.SealRevision{}, domain.ErrInvalidInput
	}
	remove := make(map[string]bool, len(markIDs))
	for _, id := range markIDs {
		if id == "" || len(id) > 128 || remove[id] {
			return domain.SealRevision{}, domain.ErrInvalidInput
		}
		remove[id] = true
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.SealRevision{}, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, actor, id, domain.ActionModify)
	if err != nil {
		return domain.SealRevision{}, err
	}
	if _, err = s.visibleFile(ctx, tx, actor, id, domain.ActionPrint); err != nil {
		return domain.SealRevision{}, err
	}
	if _, err = s.visibleFile(ctx, tx, actor, id, domain.ActionPreview); err != nil {
		return domain.SealRevision{}, err
	}
	if currentSeq(file) != seq {
		return domain.SealRevision{}, domain.ErrVersionConflict
	}
	version, err := tx.VersionBySeq(ctx, id, seq)
	if err != nil || version.Sha256 != sha {
		return domain.SealRevision{}, domain.ErrVersionConflict
	}
	store, err := sealRepository(tx)
	if err != nil {
		return domain.SealRevision{}, err
	}
	current, err := store.SealRevision(ctx, id, seq, -1)
	if err != nil {
		return domain.SealRevision{}, err
	}
	if current.Revision != expected {
		return domain.SealRevision{}, domain.ErrVersionConflict
	}
	active, err := store.ListSealMarksAtRevision(ctx, id, seq, expected)
	if err != nil {
		return domain.SealRevision{}, err
	}
	permission := domain.SealUserPermission{}
	if !actor.IsAdmin {
		permission, err = store.SealUserPermission(ctx, actor.ID)
		if err != nil {
			return domain.SealRevision{}, notFoundOr(err)
		}
	}
	remaining, hasPersonal, err := filterMarkRemoval(actor, permission, active, remove)
	if err != nil {
		return domain.SealRevision{}, err
	}
	// Only removing a personal signature requires re-authentication. A company
	// stamp removal is permitted by file Modify/Print/Preview + mark ownership
	// and current stamp permission (or administrator status).
	if hasPersonal {
		if password == "" {
			return domain.SealRevision{}, ErrInvalidCredentials
		}
		identity, hash, authErr := tx.UserByLogin(ctx, actor.Login)
		if authErr != nil || identity.ID != actor.ID || bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
			return domain.SealRevision{}, ErrInvalidCredentials
		}
	}
	rev := domain.SealRevision{
		ID: NewID("sealrev"), FileID: id, VersionSeq: seq, Revision: expected + 1,
		MarkIDs: remaining, MarkCount: len(remaining), Action: "revoke",
		ActorID: actor.ID, ActorName: actor.DisplayName, CreatedAt: s.now(),
	}
	if err = store.AppendSealRevision(ctx, rev, expected); err != nil {
		return domain.SealRevision{}, err
	}
	if err = auditRequired(ctx, tx, actor, "seal.mark_revoke", "file", id, "success", map[string]any{
		"versionSeq": seq, "fileSha256": sha, "priorRevision": expected,
		"newRevision": rev.Revision, "markIds": markIDs, "removedCount": len(markIDs),
		"remainingCount": len(remaining),
	}); err != nil {
		return domain.SealRevision{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.SealRevision{}, err
	}
	return rev, nil
}

// filterMarkRemoval is pure and validates the entire selection atomically.
// Callers cannot remove another person's evidence without admin rights; stamp
// removal also requires current can_stamp permission for ordinary users.
func filterMarkRemoval(actor domain.User, permission domain.SealUserPermission, active []domain.FileSealMark, remove map[string]bool) ([]string, bool, error) {
	remaining := make([]string, 0, len(active))
	hasPersonal := false
	for _, mark := range active {
		if !remove[mark.ID] {
			remaining = append(remaining, mark.ID)
			continue
		}
		if !actor.IsAdmin && mark.SignerID != actor.ID {
			return nil, false, domain.ErrForbidden
		}
		switch mark.AssetKind {
		case "personal":
			hasPersonal = true
		case "company":
			if !actor.IsAdmin && !permission.CanStamp {
				return nil, false, domain.ErrForbidden
			}
		default:
			return nil, false, domain.ErrInvalidInput
		}
		delete(remove, mark.ID)
	}
	if len(remove) > 0 {
		return nil, false, domain.ErrVersionConflict
	}
	return remaining, hasPersonal, nil
}
