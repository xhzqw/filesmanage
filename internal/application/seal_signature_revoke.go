package application

import (
	"context"
	"filesmanage/internal/domain"
	"golang.org/x/crypto/bcrypt"
)

// RevokeFileSignatures removes only selected, currently-visible personal
// signatures from the next immutable revision. Original marks and all earlier
// revisions are retained as evidence and remain available to audit/restore.
func (s *Service) RevokeFileSignatures(ctx context.Context, actor domain.User, id string, seq int, sha string, expected int, markIDs []string, password string) (domain.SealRevision, error) {
	if seq < 1 || expected < 1 || len(sha) != 64 || len(password) < 1 || len(password) > 1024 || len(markIDs) < 1 || len(markIDs) > 120 {
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
	identity, hash, err := tx.UserByLogin(ctx, actor.Login)
	if err != nil || identity.ID != actor.ID || bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return domain.SealRevision{}, ErrInvalidCredentials
	}
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
	remaining, err := filterSignatureRemoval(actor, active, remove)
	if err != nil {
		return domain.SealRevision{}, err
	}
	rev := domain.SealRevision{
		ID: NewID("sealrev"), FileID: id, VersionSeq: seq, Revision: expected + 1,
		MarkIDs: remaining, MarkCount: len(remaining), Action: "revoke",
		ActorID: actor.ID, ActorName: actor.DisplayName, CreatedAt: s.now(),
	}
	if err = store.AppendSealRevision(ctx, rev, expected); err != nil {
		return domain.SealRevision{}, err
	}
	if err = auditRequired(ctx, tx, actor, "seal.signature_revoke", "file", id, "success", map[string]any{
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
func filterSignatureRemoval(actor domain.User, active []domain.FileSealMark, remove map[string]bool) ([]string, error) {
	remaining := make([]string, 0, len(active))
	for _, mark := range active {
		if remove[mark.ID] {
			if mark.AssetKind != "personal" || (!actor.IsAdmin && mark.SignerID != actor.ID) {
				return nil, domain.ErrForbidden
			}
			delete(remove, mark.ID)
		} else {
			remaining = append(remaining, mark.ID)
		}
	}
	if len(remove) > 0 {
		return nil, domain.ErrVersionConflict
	}
	return remaining, nil
}
