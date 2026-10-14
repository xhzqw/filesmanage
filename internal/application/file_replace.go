package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"io"
	"time"
)

// ReplaceTarget is an authorized, current-version snapshot. It is advisory:
// ReplaceExisting rechecks every field and permission under a row lock.
type ReplaceTarget struct {
	FileID     string `json:"fileId"`
	Name       string `json:"name"`
	FolderID   string `json:"folderId"`
	VersionSeq int    `json:"versionSeq"`
	Size       int64  `json:"size"`
}

func (s *Service) ResolveReplaceTarget(ctx context.Context, u domain.User, folderID, name string) (ReplaceTarget, error) {
	if folderID == "" || name == "" || len(name) > 200 {
		return ReplaceTarget{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return ReplaceTarget{}, err
	}
	defer tx.Rollback(ctx)
	if err = s.require(ctx, tx, u, folderID, domain.ActionUpload); err != nil {
		return ReplaceTarget{}, domain.ErrNotFound
	}
	file, err := tx.FileByNameInFolder(ctx, folderID, name)
	if err != nil {
		return ReplaceTarget{}, domain.ErrNotFound
	}
	file, err = s.visibleFile(ctx, tx, u, file.ID, domain.ActionModify)
	if err != nil {
		return ReplaceTarget{}, domain.ErrNotFound
	}
	if err = replacementReady(ctx, tx, file, s.now()); err != nil {
		return ReplaceTarget{}, err
	}
	return ReplaceTarget{FileID: file.ID, FolderID: file.FolderID, Name: file.Name, VersionSeq: currentSeq(file), Size: file.SizeBytes}, nil
}

// replacementReady fails closed on approval and editor-lock state. Explicit
// byte replacement must never bypass the existing approval/lock workflow.
func replacementReady(ctx context.Context, tx ports.Repository, file domain.File, nowTime time.Time) error {
	policy, found, err := tx.ApprovalPolicyFor(ctx, file.FolderID)
	if err != nil {
		return err
	}
	if found && policy.Enabled {
		return domain.ErrApprovalPending
	}
	if _, pending, err := tx.PendingApprovalForFile(ctx, file.ID); err != nil {
		return err
	} else if pending {
		return domain.ErrApprovalPending
	}
	lock, err := tx.LockByFileID(ctx, file.ID)
	if err == nil && lock.ExpiresAt.After(nowTime) {
		return domain.ErrLocked
	}
	if err != nil && !errors.Is(err, ports.ErrRowMissing) {
		return err
	}
	return nil
}

// ReplaceExisting uses the stable target ID and an explicit version CAS.
// Every successful replacement appends a new immutable version and an audit
// event in the same transaction. A stale target, name or content version fails.
func (s *Service) ReplaceExisting(ctx context.Context, u domain.User, folderID, fileID, name string, expectedSeq int, contentType, idempotencyKey string, content io.Reader) (UploadResult, error) {
	if folderID == "" || fileID == "" || name == "" || expectedSeq < 1 || len(name) > 200 {
		return UploadResult{}, domain.ErrInvalidInput
	}
	// Reject unauthorized or stale uploads before accepting bytes or publishing
	// any ready blob. Final checks under the file row lock are still required.
	preflight, err := s.uow.Begin(ctx)
	if err != nil {
		return UploadResult{}, err
	}
	file, err := s.visibleFile(ctx, preflight, u, fileID, domain.ActionModify)
	if err != nil {
		_ = preflight.Rollback(ctx)
		return UploadResult{}, err
	}
	if file.FolderID != folderID || file.Name != name {
		_ = preflight.Rollback(ctx)
		return UploadResult{}, domain.ErrVersionConflict
	}
	if err = s.require(ctx, preflight, u, folderID, domain.ActionUpload); err != nil {
		_ = preflight.Rollback(ctx)
		return UploadResult{}, err
	}
	if err = replacementReady(ctx, preflight, file, s.now()); err != nil {
		_ = preflight.Rollback(ctx)
		return UploadResult{}, err
	}
	operation := "file.replace:" + fileID
	// A replay may refer to a version already committed by this request.
	if currentSeq(file) != expectedSeq {
		_, replay, lookupErr := idempotentResult(ctx, preflight, u.ID, operation, idempotencyKey)
		if lookupErr != nil || !replay {
			_ = preflight.Rollback(ctx)
			if lookupErr != nil {
				return UploadResult{}, lookupErr
			}
			return UploadResult{}, domain.ErrVersionConflict
		}
	}
	if err = preflight.Rollback(ctx); err != nil {
		return UploadResult{}, err
	}
	stage, err := s.blobs.Stage()
	if err != nil {
		return UploadResult{}, err
	}
	fingerprint := sha256.New()
	if _, err = io.Copy(io.MultiWriter(stage, fingerprint), content); err != nil {
		_ = stage.Abort()
		return UploadResult{}, err
	}
	sha := hex.EncodeToString(fingerprint.Sum(nil))
	size := stage.Size()
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		_ = stage.Abort()
		return UploadResult{}, err
	}
	defer tx.Rollback(ctx)
	defer stage.Abort()
	if err = tx.LockFileRow(ctx, fileID); err != nil {
		return UploadResult{}, domain.ErrNotFound
	}
	file, err = s.visibleFile(ctx, tx, u, fileID, domain.ActionModify)
	if err != nil {
		return UploadResult{}, err
	}
	if file.FolderID != folderID || file.Name != name {
		return UploadResult{}, domain.ErrVersionConflict
	}
	if err = s.require(ctx, tx, u, folderID, domain.ActionUpload); err != nil {
		return UploadResult{}, err
	}
	if err = replacementReady(ctx, tx, file, s.now()); err != nil {
		return UploadResult{}, err
	}
	if cached, ok, readErr := idempotentResult(ctx, tx, u.ID, operation, idempotencyKey); readErr == nil && ok {
		var result UploadResult
		if json.Unmarshal(cached, &result) == nil {
			if result.FileID != fileID || result.FolderID != folderID || result.Name != name || result.VersionSeq != expectedSeq+1 || result.Sha256 != sha || result.Size != size {
				return UploadResult{}, domain.ErrVersionConflict
			}
			return result, nil
		}
		return UploadResult{}, domain.ErrConflict
	} else if readErr != nil {
		return UploadResult{}, readErr
	}
	if currentSeq(file) != expectedSeq {
		return UploadResult{}, domain.ErrVersionConflict
	}
	key, dedup, err := stage.Commit()
	if err != nil {
		return UploadResult{}, err
	}
	blob, err := ensureBlob(ctx, tx, key, sha, size)
	if err != nil {
		return UploadResult{}, err
	}
	version, err := s.appendVersionTx(ctx, tx, u, file, blob, sha, size, domain.VersionActionEdit, nil, "upload replacement")
	if err != nil {
		return UploadResult{}, err
	}
	if contentType != "" && contentType != file.ContentType {
		if err = tx.SetFileContentType(ctx, file.ID, contentType); err != nil {
			return UploadResult{}, err
		}
	}
	result := UploadResult{FileID: file.ID, FolderID: folderID, Name: name, VersionSeq: version.Seq, Size: size, Sha256: sha, Dedup: dedup}
	if err = auditRequired(ctx, tx, u, "file.replace", "file", file.ID, "success", map[string]any{
		"baseSeq": expectedSeq, "versionSeq": version.Seq, "oldSha256": file.Sha256,
		"sha256": sha, "oldSize": file.SizeBytes, "size": size, "name": name, "folderId": folderID,
	}); err != nil {
		return UploadResult{}, err
	}
	if idempotencyKey != "" {
		if err = tx.IdempotencyPut(ctx, u.ID, operation, idempotencyKey, mustMarshal(result)); err != nil {
			return UploadResult{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return UploadResult{}, err
	}
	s.ReindexFile(ctx, file.ID)
	s.notifyWorkspaceChange("file", "search", "stats")
	return result, nil
}
