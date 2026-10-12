package application

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"time"
)

// Workflow use cases: approval policies, edit locks and approval decisions.

// ---------- policies (admin-only) ----------

func (s *Service) ApprovalPolicy(ctx context.Context, u domain.User, folderID string) (domain.ApprovalPolicy, bool, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.ApprovalPolicy{}, false, err
	}
	defer tx.Rollback(ctx)
	folder, err := s.activeFolder(ctx, tx, folderID)
	if err != nil {
		return domain.ApprovalPolicy{}, false, err
	}
	if !u.IsAdmin {
		if err = s.require(ctx, tx, u, folder.ID, domain.ActionList); err != nil {
			return domain.ApprovalPolicy{}, false, err
		}
	}
	return tx.ApprovalPolicyFor(ctx, folder.ID)
}

func (s *Service) SetApprovalPolicy(ctx context.Context, actor domain.User, folderID, approverID string, enabled bool) error {
 return s.SetApprovalChainPolicy(ctx,actor,folderID,[]string{approverID},enabled)
}
func (s *Service) SetApprovalChainPolicy(ctx context.Context, actor domain.User, folderID string, chain []string, enabled bool) error {
 if len(chain)<1||len(chain)>5{return domain.ErrInvalidInput}
 seen:=map[string]bool{}
 for _,id:=range chain{if id==""||seen[id]{return domain.ErrInvalidInput};seen[id]=true}
	if err := s.requireAdmin(actor); err != nil {
		return err
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	folder, err := s.activeFolder(ctx, tx, folderID)
	if err != nil {
		return err
	}
	for _,id:=range chain{
		approver,err:=tx.UserByID(ctx,id)
		if err!=nil{return notFoundOr(err)}
		if approver.DisabledAt!=nil{return domain.ErrInvalidInput}
	}
	policy := domain.ApprovalPolicy{FolderID: folder.ID, ApproverID: chain[0],ApproverChain:chain, Enabled: enabled}
	if err = tx.UpsertApprovalPolicy(ctx, policy); err != nil {
		return mapError(err)
	}
	audit(ctx, tx, actor, "approval_policy.set", "folder", folder.ID, "success",
		map[string]any{"approverIds": chain, "enabled": enabled})
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notifyWorkspaceChange("approval-policy")
	return nil
}

func (s *Service) ClearApprovalPolicy(ctx context.Context, actor domain.User, folderID string) error {
	if err := s.requireAdmin(actor); err != nil {
		return err
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	folder, err := s.activeFolder(ctx, tx, folderID)
	if err != nil {
		return err
	}
	if err = tx.ClearApprovalPolicy(ctx, folder.ID); err != nil {
		return err
	}
	audit(ctx, tx, actor, "approval_policy.clear", "folder", folder.ID, "success", nil)
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notifyWorkspaceChange("approval-policy")
	return nil
}

// ---------- edit locks ----------

// AcquireLock takes the file-level single-writer lock. An unexpired lock held
// by anyone else is 409 E_LOCKED; an expired lock is taken over (its token
// dies with it).
func (s *Service) AcquireLock(ctx context.Context, u domain.User, fileID string, baseSeq int) (string, int64, error) {
	if baseSeq <= 0 {
		return "", 0, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return "", 0, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionModify)
	if err != nil {
		return "", 0, err
	}
	// Serialise every lock mutation on this file inside the transaction
	// (SPEC §7.2). Without the row lock, concurrent acquires race on
	// LockByFileID/ForceReleaseLock/InsertLock and surface as 500s.
	if err = tx.LockFileRow(ctx, file.ID); err != nil {
		return "", 0, err
	}
	if currentSeq(file) != baseSeq {
		return "", 0, domain.ErrVersionConflict
	}
	if err = s.assertNoApprovalPolicy(ctx, tx, file.FolderID); err != nil {
		// Under an approval policy the modification path routes through a
		// pending request instead of a direct lock-holding save.
		if errors.Is(err, domain.ErrApprovalPending) {
			return "", 0, domain.ErrApprovalPending
		}
		return "", 0, err
	}
	existing, err := tx.LockByFileID(ctx, file.ID)
	switch {
	case err == nil && existing.ExpiresAt.After(s.now()):
		if existing.OwnerID != u.ID {
			return "", 0, domain.ErrLocked
		}
		// Re-acquiring your own live lock replaces it: the caller receives a
		// fresh token and generation while the previous token stops working,
		// so a stale editor tab can never release the new holder's lock.
		if _, forceErr := tx.ForceReleaseLock(ctx, file.ID); forceErr != nil {
			return "", 0, forceErr
		}
		audit(ctx, tx, u, "file.lock_reacquire", "file", file.ID, "success",
			map[string]any{"baseSeq": baseSeq, "previousGeneration": existing.Generation})
	case err != nil && !errors.Is(err, ports.ErrRowMissing):
		return "", 0, err
	case err == nil:
		// Expired lease (any holder): take it over, the old token dies with it.
		if _, forceErr := tx.ForceReleaseLock(ctx, file.ID); forceErr != nil {
			return "", 0, forceErr
		}
		audit(ctx, tx, u, "file.lock_takeover", "file", file.ID, "success",
			map[string]any{"baseSeq": baseSeq, "previousOwner": existing.OwnerID})
	}
	raw := make([]byte, 32)
	if _, err = rand.Read(raw); err != nil {
		return "", 0, err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	lock := domain.EditLock{
		FileID: file.ID, OwnerID: u.ID, TokenHash: HashToken(token),
		BaseSeq: baseSeq, ExpiresAt: s.now().Add(domain.LockTTL), Generation: time.Now().UnixNano(),
	}
	if err = tx.InsertLock(ctx, lock); err != nil {
		if errors.Is(err, domain.ErrLocked) {
			return "", 0, domain.ErrLocked
		}
		return "", 0, err
	}
	audit(ctx, tx, u, "file.lock_acquire", "file", file.ID, "success", map[string]any{"baseSeq": baseSeq})
	if err = tx.Commit(ctx); err != nil {
		return "", 0, err
	}
	return token, lock.Generation, nil
}

func (s *Service) RenewLock(ctx context.Context, u domain.User, fileID, lockToken string) error {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionModify)
	if err != nil {
		return err
	}
	lock, err := tx.LockByFileID(ctx, file.ID)
	if err != nil {
		return notFoundOr(err)
	}
	if lock.OwnerID != u.ID || lock.TokenHash != HashToken(lockToken) {
		return domain.ErrLocked
	}
	ok, err := tx.RenewLock(ctx, file.ID, lock.TokenHash, s.now().Add(domain.LockTTL), lock.Generation)
	if err != nil {
		return err
	}
	if !ok {
		return domain.ErrLocked
	}
	audit(ctx, tx, u, "file.lock_renew", "file", file.ID, "success", nil)
	return tx.Commit(ctx)
}

// ReleaseLock frees the caller's own lock. A stale token (the lock was taken
// over or force-released meanwhile) must not release the new holder's lock.
func (s *Service) ReleaseLock(ctx context.Context, u domain.User, fileID, lockToken string) error {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionModify)
	if err != nil {
		return err
	}
	lock, err := tx.LockByFileID(ctx, file.ID)
	if err != nil {
		return notFoundOr(err)
	}
	if lock.TokenHash != HashToken(lockToken) {
		return domain.ErrVersionConflict
	}
	if lock.OwnerID != u.ID && !u.IsAdmin {
		return domain.ErrForbidden
	}
	if _, err = tx.ReleaseLock(ctx, file.ID, lock.TokenHash); err != nil {
		return err
	}
	audit(ctx, tx, u, "file.lock_release", "file", file.ID, "success", map[string]any{"forced": lock.OwnerID != u.ID})
	return tx.Commit(ctx)
}

func (s *Service) LockStatus(ctx context.Context, u domain.User, fileID string) (domain.EditLock, bool, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.EditLock{}, false, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionList)
	if err != nil {
		return domain.EditLock{}, false, err
	}
	lock, err := tx.LockByFileID(ctx, file.ID)
	if err != nil {
		if errors.Is(err, ports.ErrRowMissing) {
			return domain.EditLock{}, false, nil
		}
		return domain.EditLock{}, false, err
	}
	if lock.ExpiresAt.After(s.now()) {
		return lock, true, nil
	}
	return lock, false, nil
}

// requireOwnLock enforces the SPEC §7.3 rule: a save must present the live
// lock token of the file.
func (s *Service) requireOwnLock(ctx context.Context, repo ports.Repository, u domain.User, file domain.File, lockToken string) error {
	lock, err := repo.LockByFileID(ctx, file.ID)
	if err != nil {
		if errors.Is(err, ports.ErrRowMissing) {
			return domain.ErrLocked
		}
		return err
	}
	if lock.TokenHash != HashToken(lockToken) {
		return domain.ErrLocked
	}
	if lock.OwnerID != u.ID {
		return domain.ErrForbidden
	}
	if !lock.ExpiresAt.After(s.now()) {
		return domain.ErrLocked
	}
	if lock.BaseSeq != currentSeq(file) {
		return domain.ErrVersionConflict
	}
	return nil
}
