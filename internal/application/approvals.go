package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

// Approval use cases. Under an active folder policy, saves and rollbacks become
// pending requests; the approver (or admin) commits them into a new version.

// SubmitEdit creates a pending approval carrying the proposed bytes. The
// current version stays untouched; previews and downloads keep returning the
// committed content.
func (s *Service) SubmitEdit(ctx context.Context, u domain.User, fileID string, content []byte, baseSeq int, reason string) (domain.Approval, error) {
	if baseSeq <= 0 {
		return domain.Approval{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.Approval{}, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionModify)
	if err != nil {
		return domain.Approval{}, err
	}
	if currentSeq(file) != baseSeq {
		return domain.Approval{}, domain.ErrVersionConflict
	}
	policy, found, err := tx.ApprovalPolicyFor(ctx, file.FolderID)
	if err != nil {
		return domain.Approval{}, err
	}
	if !found || !policy.Enabled {
		return domain.Approval{}, domain.ErrInvalidInput
	}
	if _, pending, err := tx.PendingApprovalForFile(ctx, file.ID); err != nil {
		return domain.Approval{}, err
	} else if pending {
		return domain.Approval{}, domain.ErrApprovalPending
	}
	stage, err := s.blobs.Stage()
	if err != nil {
		return domain.Approval{}, err
	}
	if _, err = stage.Write(content); err != nil {
		_ = stage.Abort()
		return domain.Approval{}, err
	}
	storageKey, _, err := stage.Commit()
	if err != nil {
		_ = stage.Abort()
		return domain.Approval{}, err
	}
	blob, err := ensureBlob(ctx, tx, storageKey, stage.Sha256(), stage.Size())
	if err != nil {
		return domain.Approval{}, err
	}
	if err = tx.SetBlobState(ctx, blob.ID, "staging"); err != nil {
		return domain.Approval{}, err
	}
	approval := domain.Approval{
		ID: NewID("appr"), FileID: file.ID, RequesterID: u.ID, ApproverID: policy.ApproverID,
		PayloadBlobID: blob.ID, BaseSeq: baseSeq, Action: domain.VersionActionEdit,
		State: domain.ApprovalPending, Reason: reason,
	}
	if err = tx.CreateApproval(ctx, approval); err != nil {
		return domain.Approval{}, mapError(err)
	}
	audit(ctx, tx, u, "approval.request", "file", file.ID, "success",
		map[string]any{"approvalId": approval.ID, "baseSeq": baseSeq, "action": approval.Action})
	if err = tx.Commit(ctx); err != nil {
		return domain.Approval{}, err
	}
	return approval, nil
}

// SubmitRollback requests an append-only rollback under an approval policy.
func (s *Service) SubmitRollback(ctx context.Context, u domain.User, fileID string, targetSeq, expectedCurrentSeq int, reason string) (domain.Approval, error) {
	if targetSeq <= 0 || expectedCurrentSeq <= 0 {
		return domain.Approval{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.Approval{}, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionModify)
	if err != nil {
		return domain.Approval{}, err
	}
	if currentSeq(file) != expectedCurrentSeq {
		return domain.Approval{}, domain.ErrVersionConflict
	}
	policy, found, err := tx.ApprovalPolicyFor(ctx, file.FolderID)
	if err != nil {
		return domain.Approval{}, err
	}
	if !found || !policy.Enabled {
		return domain.Approval{}, domain.ErrInvalidInput
	}
	if _, pending, err := tx.PendingApprovalForFile(ctx, file.ID); err != nil {
		return domain.Approval{}, err
	} else if pending {
		return domain.Approval{}, domain.ErrApprovalPending
	}
	target, err := tx.VersionBySeq(ctx, file.ID, targetSeq)
	if err != nil {
		return domain.Approval{}, domain.ErrNotFound
	}
	if target.Seq >= expectedCurrentSeq {
		return domain.Approval{}, domain.ErrVersionConflict
	}
	approval := domain.Approval{
		ID: NewID("appr"), FileID: file.ID, RequesterID: u.ID, ApproverID: policy.ApproverID,
		PayloadBlobID: target.BlobID, BaseSeq: expectedCurrentSeq, Action: domain.VersionActionRollback,
		RollbackTargetSeq: new(targetSeq), State: domain.ApprovalPending, Reason: reason,
	}
	if err = tx.CreateApproval(ctx, approval); err != nil {
		return domain.Approval{}, mapError(err)
	}
	audit(ctx, tx, u, "approval.request", "file", file.ID, "success",
		map[string]any{"approvalId": approval.ID, "targetSeq": targetSeq, "action": approval.Action})
	if err = tx.Commit(ctx); err != nil {
		return domain.Approval{}, err
	}
	return approval, nil
}

// Approve commits the pending modification as a new immutable version. The
// file row is locked for the whole transaction and the base version is
// re-verified, so at most one concurrent approver can win; a loser sees
// E_VERSION_CONFLICT and the request is marked conflicted.
func (s *Service) Approve(ctx context.Context, actor domain.User, approvalID, comment string) (SaveResult, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return SaveResult{}, err
	}
	defer tx.Rollback(ctx)
	approval, err := tx.ApprovalByID(ctx, approvalID)
	if err != nil {
		return SaveResult{}, notFoundOr(err)
	}
	if approval.State != domain.ApprovalPending {
		return SaveResult{}, domain.ErrVersionConflict
	}
	if actor.ID != approval.ApproverID && !actor.IsAdmin {
		return SaveResult{}, domain.ErrForbidden
	}
	file, err := s.authorizedFileForApproval(ctx, tx, actor, approval)
	if err != nil {
		return SaveResult{}, err
	}
	if currentSeq(file) != approval.BaseSeq {
		if won, _ := tx.DecideApproval(ctx, approvalID, domain.ApprovalConflicted, comment); won {
			audit(ctx, tx, actor, "approval.conflict", "file", approval.FileID, "success",
				map[string]any{"approvalId": approvalID})
			_ = tx.Commit(ctx)
		}
		return SaveResult{}, domain.ErrVersionConflict
	}
	target, err := tx.VersionBySeq(ctx, approval.FileID, currentSeq(file))
	if err != nil {
		return SaveResult{}, domain.ErrNotFound
	}
	next, err := tx.NextVersionSeq(ctx, approval.FileID)
	if err != nil {
		return SaveResult{}, err
	}
	version := domain.FileVersion{
		ID: NewID("ver"), FileID: approval.FileID, Seq: next, BlobID: approval.PayloadBlobID,
		SizeBytes: approval.PayloadSize, Sha256: approval.PayloadSha256, Action: approval.Action,
		BaseSeq: new(currentSeq(file)), CreatedBy: approval.RequesterID, Reason: approval.Reason,
	}
	if approval.Action == domain.VersionActionRollback && approval.RollbackTargetSeq != nil {
		version.RollbackTargetSeq = approval.RollbackTargetSeq
		version.RollbackFromSeq = new(currentSeq(file))
	}
	if err = tx.AppendVersion(ctx, version); err != nil {
		return SaveResult{}, mapError(err)
	}
	if err = tx.UpdateCurrentVersion(ctx, approval.FileID, next); err != nil {
		return SaveResult{}, err
	}
	if err = tx.SetBlobState(ctx, approval.PayloadBlobID, "ready"); err != nil {
		return SaveResult{}, err
	}
	won, err := tx.DecideApproval(ctx, approvalID, domain.ApprovalApproved, comment)
	if err != nil {
		return SaveResult{}, err
	}
	if !won {
		return SaveResult{}, domain.ErrVersionConflict
	}
	result := SaveResult{FileID: approval.FileID, VersionSeq: next, Sha256: approval.PayloadSha256, Size: approval.PayloadSize}
	audit(ctx, tx, actor, "approval.approve", "file", approval.FileID, "success",
		map[string]any{"approvalId": approvalID, "versionSeq": next, "requesterId": approval.RequesterID})
	_ = target
	if err = tx.Commit(ctx); err != nil {
		return SaveResult{}, err
	}
	// The approved version is now current; the search index follows it.
	s.ReindexFile(ctx, approval.FileID)
	return result, nil
}

// Reject closes the request without publishing anything; the committed
// version stays as-is.
func (s *Service) Reject(ctx context.Context, actor domain.User, approvalID, comment string) error {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	approval, err := tx.ApprovalByID(ctx, approvalID)
	if err != nil {
		return notFoundOr(err)
	}
	if approval.State != domain.ApprovalPending {
		return domain.ErrVersionConflict
	}
	if actor.ID != approval.ApproverID && !actor.IsAdmin {
		return domain.ErrForbidden
	}
	won, err := tx.DecideApproval(ctx, approvalID, domain.ApprovalRejected, comment)
	if err != nil {
		return err
	}
	if !won {
		return domain.ErrVersionConflict
	}
	if approval.Action == domain.VersionActionEdit {
		_ = tx.SetBlobState(ctx, approval.PayloadBlobID, "gc_pending")
	}
	audit(ctx, tx, actor, "approval.reject", "file", approval.FileID, "success",
		map[string]any{"approvalId": approvalID, "requesterId": approval.RequesterID})
	return tx.Commit(ctx)
}

// Cancel lets the requester (or an admin) withdraw a pending request.
func (s *Service) CancelApproval(ctx context.Context, actor domain.User, approvalID string) error {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	approval, err := tx.ApprovalByID(ctx, approvalID)
	if err != nil {
		return notFoundOr(err)
	}
	if approval.State != domain.ApprovalPending {
		return domain.ErrVersionConflict
	}
	if actor.ID != approval.RequesterID && !actor.IsAdmin {
		return domain.ErrForbidden
	}
	won, err := tx.DecideApproval(ctx, approvalID, domain.ApprovalCancelled, "")
	if err != nil {
		return err
	}
	if !won {
		return domain.ErrVersionConflict
	}
	if approval.Action == domain.VersionActionEdit {
		_ = tx.SetBlobState(ctx, approval.PayloadBlobID, "gc_pending")
	}
	audit(ctx, tx, actor, "approval.cancel", "file", approval.FileID, "success",
		map[string]any{"approvalId": approvalID})
	return tx.Commit(ctx)
}

func (s *Service) authorizedFileForApproval(ctx context.Context, repo ports.Repository, actor domain.User, approval domain.Approval) (domain.File, error) {
	file, err := repo.FileByID(ctx, approval.FileID)
	if err != nil {
		return domain.File{}, domain.ErrNotFound
	}
	if file.DeletedAt != nil {
		return domain.File{}, domain.ErrNotFound
	}
	if actor.ID == approval.ApproverID || actor.IsAdmin {
		// The approver only needs visibility of the file to decide.
		if _, err = s.activeFolder(ctx, repo, file.FolderID); err != nil {
			return domain.File{}, err
		}
		if !actor.IsAdmin {
			visible, visErr := s.visibleFile(ctx, repo, actor, approval.FileID, domain.ActionList)
			if visErr != nil {
				return domain.File{}, visErr
			}
			_ = visible
		}
		return file, nil
	}
	return domain.File{}, domain.ErrForbidden
}

func (s *Service) ListApprovals(ctx context.Context, u domain.User, scope string) ([]domain.Approval, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	switch scope {
	case "inbox":
		if !u.IsAdmin {
			// non-admin approvers only see requests assigned to them
		}
		return tx.ListApprovalsForApprover(ctx, u.ID)
	case "mine":
		return tx.ListApprovalsByRequester(ctx, u.ID)
	default:
		return nil, domain.ErrInvalidInput
	}
}
