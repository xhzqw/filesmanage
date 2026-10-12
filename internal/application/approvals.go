package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

// Approval use cases. Under an active folder policy, saves and rollbacks become
// pending requests; the approver (or admin) commits them into a new version.

// OpenApprovalDraft exposes immutable proposed bytes only to an approval participant
// who still holds explicit file-download rights. It never publishes the staged blob.
func (s *Service) OpenApprovalDraft(ctx context.Context, actor domain.User, approvalID string) (Download, func(), error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return Download{}, nil, err
	}
	defer tx.Rollback(ctx)
	approval, err := tx.ApprovalByID(ctx, approvalID)
	if err != nil {
		return Download{}, nil, notFoundOr(err)
	}
	if approval.State != domain.ApprovalPending {
		return Download{}, nil, domain.ErrNotFound
	}
	participant := actor.IsAdmin || actor.ID == approval.RequesterID
	for _, id := range approval.ApproverChain {
		if actor.ID == id {
			participant = true
		}
	}
	if !participant {
		return Download{}, nil, domain.ErrForbidden
	}
	file, err := s.visibleFile(ctx, tx, actor, approval.FileID, domain.ActionDownload)
	if err != nil {
		return Download{}, nil, err
	}
	blob, err := tx.BlobByID(ctx, approval.PayloadBlobID)
	if err != nil {
		return Download{}, nil, domain.ErrNotFound
	}
	reader, err := s.blobs.Open(blob.StorageKey)
	if err != nil {
		return Download{}, nil, err
	}
	return Download{
		FileName: file.Name, Sha256: blob.Sha256, Size: blob.SizeBytes,
		ContentType: "application/octet-stream", Reader: reader, ModTime: approval.CreatedAt,
	}, func() { _ = reader.Close() }, nil
}

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
		ID: NewID("appr"), FileID: file.ID, RequesterID: u.ID, ApproverID: policy.ApproverID, ApproverChain: policy.ApproverChain,
		PayloadBlobID: blob.ID, BaseSeq: baseSeq, Action: domain.VersionActionEdit,
		State: domain.ApprovalPending, Reason: reason,
	}
	if err = tx.CreateApproval(ctx, approval); err != nil {
		return domain.Approval{}, mapError(err)
	}
	if err = s.approvalEvent(ctx, tx, approval, u, "submitted", reason, approval.ApproverID); err != nil {
		return domain.Approval{}, err
	}
	audit(ctx, tx, u, "approval.request", "file", file.ID, "success",
		map[string]any{"approvalId": approval.ID, "baseSeq": baseSeq, "action": approval.Action})
	if err = tx.Commit(ctx); err != nil {
		return domain.Approval{}, err
	}
	s.notifyApprovalChanges(approval.ApproverID)
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
		ID: NewID("appr"), FileID: file.ID, RequesterID: u.ID, ApproverID: policy.ApproverID, ApproverChain: policy.ApproverChain,
		PayloadBlobID: target.BlobID, BaseSeq: expectedCurrentSeq, Action: domain.VersionActionRollback,
		RollbackTargetSeq: new(targetSeq), State: domain.ApprovalPending, Reason: reason,
	}
	if err = tx.CreateApproval(ctx, approval); err != nil {
		return domain.Approval{}, mapError(err)
	}
	if err = s.approvalEvent(ctx, tx, approval, u, "submitted", reason, approval.ApproverID); err != nil {
		return domain.Approval{}, err
	}
	audit(ctx, tx, u, "approval.request", "file", file.ID, "success",
		map[string]any{"approvalId": approval.ID, "targetSeq": targetSeq, "action": approval.Action})
	if err = tx.Commit(ctx); err != nil {
		return domain.Approval{}, err
	}
	s.notifyApprovalChanges(approval.ApproverID)
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
			if err = s.approvalEvent(ctx, tx, approval, actor, "conflicted", comment, approval.RequesterID); err == nil && tx.Commit(ctx) == nil {
				s.notifyApprovalChanges(approval.RequesterID)
			}
		}
		return SaveResult{}, domain.ErrVersionConflict
	}
	// Non-final approvals advance the chain without publishing bytes.
	if approval.StepIndex+1 < len(approval.ApproverChain) {
		nextID := approval.ApproverChain[approval.StepIndex+1]
		won, err := tx.AdvanceApproval(ctx, approval.ID, approval.StepIndex, nextID)
		if err != nil {
			return SaveResult{}, err
		}
		if !won {
			return SaveResult{}, domain.ErrVersionConflict
		}
		if err = auditRequired(ctx, tx, actor, "approval.step_approved", "file", approval.FileID, "success", map[string]any{
			"approvalId": approval.ID, "step": approval.StepIndex + 1, "nextApproverId": nextID, "comment": comment,
		}); err != nil {
			return SaveResult{}, err
		}
		if err = s.approvalEvent(ctx, tx, approval, actor, "advanced", comment, nextID, approval.RequesterID); err != nil {
			return SaveResult{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return SaveResult{}, err
		}
		s.notifyApprovalChanges(nextID, approval.RequesterID)
		return SaveResult{FileID: approval.FileID}, nil
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
	if err = s.approvalEvent(ctx, tx, approval, actor, "approved", comment, approval.RequesterID); err != nil {
		return SaveResult{}, err
	}
	_ = target
	if err = tx.Commit(ctx); err != nil {
		return SaveResult{}, err
	}
	// The approved version is now current; the search index follows it.
	s.notifyApprovalChanges(approval.RequesterID)
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
	if err = s.approvalEvent(ctx, tx, approval, actor, "rejected", comment, approval.RequesterID); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notifyApprovalChanges(approval.RequesterID)
	return nil
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
	if err = s.approvalEvent(ctx, tx, approval, actor, "cancelled", "", approval.ApproverID); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notifyApprovalChanges(approval.ApproverID)
	return nil
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
