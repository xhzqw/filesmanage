package application

import (
	"context"
	"filesmanage/internal/domain"
	"golang.org/x/crypto/bcrypt"
)

// The virtual revision 0 is the original unsigned PDF. Every other snapshot
// is append-only, preserving both historic visual state and original evidence.
type SealRevisionHistory struct {
	Current   int                   `json:"current"`
	Revisions []domain.SealRevision `json:"revisions"`
}

func (s *Service) SealHistory(ctx context.Context, actor domain.User, id string, seq int) (SealRevisionHistory, error) {
	if seq < 1 {
		return SealRevisionHistory{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return SealRevisionHistory{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = s.visibleFile(ctx, tx, actor, id, domain.ActionPreview); err != nil {
		return SealRevisionHistory{}, err
	}
	if _, err = tx.VersionBySeq(ctx, id, seq); err != nil {
		return SealRevisionHistory{}, domain.ErrNotFound
	}
	store, err := sealRepository(tx)
	if err != nil {
		return SealRevisionHistory{}, err
	}
	items, err := store.ListSealRevisions(ctx, id, seq)
	if err != nil {
		return SealRevisionHistory{}, err
	}
	history := SealRevisionHistory{Revisions: items}
	if len(items) > 0 {
		history.Current = items[0].Revision
	}
	history.Revisions = append(history.Revisions, domain.SealRevision{
		FileID: id, VersionSeq: seq, Revision: 0, Action: "original", MarkCount: 0,
	})
	return history, nil
}

func (s *Service) RestoreSealRevision(ctx context.Context, actor domain.User, id string, seq int, sha string, expected, target int, password string) (domain.SealRevision, error) {
	// Rollback of other people's approvals/signatures needs administrator authority.
	if !actor.IsAdmin {
		return domain.SealRevision{}, domain.ErrForbidden
	}
	if seq < 1 || expected < 0 || target < 0 || target > expected || len(sha) != 64 || len(password) == 0 || len(password) > 1024 {
		return domain.SealRevision{}, domain.ErrInvalidInput
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
	historic, err := store.SealRevision(ctx, id, seq, target)
	if err != nil {
		return domain.SealRevision{}, notFoundOr(err)
	}
	if current.Revision == target {
		return domain.SealRevision{}, domain.ErrInvalidInput
	}
	restored := target
	rev := domain.SealRevision{
		ID: NewID("sealrev"), FileID: id, VersionSeq: seq, Revision: expected + 1,
		MarkIDs: append([]string{}, historic.MarkIDs...), MarkCount: len(historic.MarkIDs),
		Action: "restore", ActorID: actor.ID, ActorName: actor.DisplayName, RestoredFrom: &restored, CreatedAt: s.now(),
	}
	if err = store.AppendSealRevision(ctx, rev, expected); err != nil {
		return domain.SealRevision{}, err
	}
	if err = auditRequired(ctx, tx, actor, "seal.restore", "file", id, "success", map[string]any{
		"versionSeq": seq, "fileSha256": sha, "fromRevision": expected, "restoredFrom": target,
		"newRevision": rev.Revision, "markCount": rev.MarkCount,
	}); err != nil {
		return domain.SealRevision{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.SealRevision{}, err
	}
	return rev, nil
}
