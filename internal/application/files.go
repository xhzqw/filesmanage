package application

import (
	"context"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"io"
	"strings"
	"time"
)

// File use cases implement the §7.1 upload, §7.3 save and §7.5 append-only
// rollback flows. Bytes are staged outside the transaction; the transaction
// only assigns ids, versions, checksums and audit rows.

type UploadResult struct {
	FileID     string
	VersionSeq int
	Sha256     string
	Size       int64
	Name       string
	FolderID   string
	Dedup      bool
}

// CommitUpload finalizes a streamed upload: the caller has already written the
// request body into stage.
func (s *Service) CommitUpload(ctx context.Context, u domain.User, folderID, fileName, contentType, idempotencyKey string, content io.Reader) (UploadResult, error) {
	fileName = strings.TrimSpace(fileName)
	if folderID == "" || fileName == "" || len(fileName) > 200 {
		return UploadResult{}, domain.ErrInvalidInput
	}
	stage, err := s.blobs.Stage()
	if err != nil {
		return UploadResult{}, err
	}
	if _, err = io.Copy(stage, content); err != nil {
		_ = stage.Abort()
		return UploadResult{}, err
	}
	storageKey, dedup, err := stage.Commit()
	if err != nil {
		_ = stage.Abort()
		return UploadResult{}, err
	}
	sha, size := stage.Sha256(), stage.Size()
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return UploadResult{}, err
	}
	defer tx.Rollback(ctx)
	if cached, ok, err := idempotentResult(ctx, tx, u.ID, "file.upload", idempotencyKey); err == nil && ok {
		var result UploadResult
		if jsonErr := json.Unmarshal(cached, &result); jsonErr == nil {
			return result, nil
		}
	}
	folder, err := s.activeFolder(ctx, tx, folderID)
	if err != nil {
		return UploadResult{}, err
	}
	if err = s.require(ctx, tx, u, folder.ID, domain.ActionUpload); err != nil {
		return UploadResult{}, err
	}
	// Approval policies gate modifications of existing files (save/rollback),
	// never the creation of a new file's first version.
	if _, err = tx.FileByNameInFolder(ctx, folder.ID, fileName); err == nil {
		return UploadResult{}, domain.ErrNameConflict
	} else if !isRowMissing(err) {
		return UploadResult{}, err
	}
	blob, err := ensureBlob(ctx, tx, storageKey, sha, size)
	if err != nil {
		return UploadResult{}, err
	}
	file := domain.File{
		ID: NewID("file"), FolderID: folder.ID, Name: fileName, UploadedBy: u.ID,
		ContentType: contentType, CurrentVersionSeq: new(1), SizeBytes: size, Sha256: sha,
	}
	version := domain.FileVersion{
		ID: NewID("ver"), FileID: file.ID, Seq: 1, BlobID: blob.ID, SizeBytes: size,
		Sha256: sha, Action: domain.VersionActionUpload, CreatedBy: u.ID,
	}
	if err = tx.CreateFileWithFirstVersion(ctx, file, version); err != nil {
		return UploadResult{}, mapError(err)
	}
	result := UploadResult{FileID: file.ID, VersionSeq: 1, Sha256: sha, Size: size, Name: fileName, FolderID: folder.ID, Dedup: dedup}
	storeIdempotentResult(ctx, tx, u.ID, "file.upload", idempotencyKey, mustMarshal(result))
	audit(ctx, tx, u, "file.upload", "file", file.ID, "success",
		map[string]any{"folderId": folder.ID, "name": fileName, "sha256": sha, "size": size, "dedup": dedup})
	if err = tx.Commit(ctx); err != nil {
		return UploadResult{}, err
	}
	return result, nil
}

// ensureBlob returns the ready blob row for a digest, inserting it once. A lost
// dedup race falls back to the existing row.
func ensureBlob(ctx context.Context, repo ports.Repository, storageKey, sha string, size int64) (domain.Blob, error) {
	if existing, err := repo.BlobBySha(ctx, sha); err == nil {
		return existing, nil
	}
	blob := domain.Blob{ID: NewID("blob"), StorageKey: storageKey, Sha256: sha, SizeBytes: size, State: "ready"}
	if err := repo.InsertBlob(ctx, blob); err != nil {
		if existing, readErr := repo.BlobBySha(ctx, sha); readErr == nil {
			return existing, nil
		}
		return domain.Blob{}, err
	}
	return blob, nil
}

type FilePage struct {
	Items      []domain.File
	NextCursor string
}

type FileCursor struct {
	Time time.Time
	ID   string
	Name string
	Size int64
}

func (s *Service) ListFiles(ctx context.Context, u domain.User, folderID, sort string, cursor FileCursor, limit int) (FilePage, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return FilePage{}, err
	}
	defer tx.Rollback(ctx)
	folder, err := s.activeFolder(ctx, tx, folderID)
	if err != nil {
		return FilePage{}, err
	}
	if err = s.require(ctx, tx, u, folder.ID, domain.ActionList); err != nil {
		return FilePage{}, err
	}
	query := ports.FileQuery{
		FolderID: folder.ID, Sort: sort, Limit: limit + 1,
		CursorTime: cursor.Time, CursorID: cursor.ID, CursorName: cursor.Name, CursorSize: cursor.Size,
	}
	items, err := tx.ListFiles(ctx, query)
	if err != nil {
		return FilePage{}, err
	}
	page := FilePage{Items: items}
	if len(items) > limit {
		page.Items = items[:limit]
		last := items[limit-1]
		page.NextCursor = encodeCursor(sort, last)
	}
	return page, nil
}

func (s *Service) FileMeta(ctx context.Context, u domain.User, fileID string) (domain.File, []domain.FileVersion, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.File{}, nil, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionList)
	if err != nil {
		return domain.File{}, nil, err
	}
	versions, err := tx.VersionsByFile(ctx, file.ID)
	if err != nil {
		return domain.File{}, nil, err
	}
	return file, versions, nil
}

type Download struct {
	FileName    string
	Sha256      string
	Size        int64
	ContentType string
	Reader      readCloser
}

type readCloser interface {
	Read([]byte) (int, error)
	Close() error
}

// OpenDownload streams the current version's source bytes after verifying the
// download permission; the caller must invoke the returned close func.
func (s *Service) OpenDownload(ctx context.Context, u domain.User, fileID string) (Download, func(), error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return Download{}, nil, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionDownload)
	if err != nil {
		return Download{}, nil, err
	}
	version, err := tx.VersionBySeq(ctx, file.ID, currentSeq(file))
	if err != nil {
		return Download{}, nil, domain.ErrNotFound
	}
	blob, err := tx.BlobByID(ctx, version.BlobID)
	if err != nil {
		return Download{}, nil, domain.ErrNotFound
	}
	reader, err := s.blobs.Open(blob.StorageKey)
	if err != nil {
		return Download{}, nil, err
	}
	return Download{
		FileName: file.Name, Sha256: blob.Sha256, Size: blob.SizeBytes,
		ContentType: file.ContentType, Reader: reader,
	}, func() { _ = reader.Close() }, nil
}

type SaveResult struct {
	FileID     string
	VersionSeq int
	Sha256     string
	Size       int64
}

// SaveOutcome distinguishes a committed version from a pending approval
// request so the transport can answer 200 or 202.
type SaveOutcome struct {
	Result   SaveResult
	Approval *domain.Approval
}

// Save writes new content as a fresh immutable version. CAS is enforced on
// baseSeq and the direct path requires the live edit lock (SPEC §7.3). Under
// an active folder policy the write becomes a pending approval instead.
func (s *Service) Save(ctx context.Context, u domain.User, fileID string, content []byte, baseSeq int, lockToken, idempotencyKey string) (SaveOutcome, error) {
	if baseSeq <= 0 {
		return SaveOutcome{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return SaveOutcome{}, err
	}
	defer tx.Rollback(ctx)
	if cached, ok, err := idempotentResult(ctx, tx, u.ID, "file.save:"+fileID, idempotencyKey); err == nil && ok {
		var outcome SaveOutcome
		if jsonErr := json.Unmarshal(cached, &outcome); jsonErr == nil {
			return outcome, nil
		}
	}
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionModify)
	if err != nil {
		return SaveOutcome{}, err
	}
	if currentSeq(file) != baseSeq {
		return SaveOutcome{}, domain.ErrVersionConflict
	}
	if policy, found, policyErr := tx.ApprovalPolicyFor(ctx, file.FolderID); policyErr == nil && found && policy.Enabled {
		approval, submitErr := s.SubmitEdit(ctx, u, fileID, content, baseSeq, "")
		if submitErr != nil {
			return SaveOutcome{}, submitErr
		}
		return SaveOutcome{Approval: &approval}, nil
	}
	if err = s.requireOwnLock(ctx, tx, u, file, lockToken); err != nil {
		return SaveOutcome{}, err
	}
	stage, err := s.blobs.Stage()
	if err != nil {
		return SaveOutcome{}, err
	}
	if _, err = stage.Write(content); err != nil {
		_ = stage.Abort()
		return SaveOutcome{}, err
	}
	storageKey, _, err := stage.Commit()
	if err != nil {
		_ = stage.Abort()
		return SaveOutcome{}, err
	}
	sha, size := stage.Sha256(), stage.Size()
	blob, err := ensureBlob(ctx, tx, storageKey, sha, size)
	if err != nil {
		return SaveOutcome{}, err
	}
	version, err := s.appendVersionTx(ctx, tx, u, file, blob, sha, size, domain.VersionActionEdit, nil, "")
	if err != nil {
		return SaveOutcome{}, err
	}
	result := SaveResult{FileID: file.ID, VersionSeq: version.Seq, Sha256: sha, Size: size}
	// A successful save releases the lock (SPEC §7.2 state machine).
	if _, err = tx.ReleaseLock(ctx, file.ID, HashToken(lockToken)); err != nil {
		return SaveOutcome{}, err
	}
	outcome := SaveOutcome{Result: result}
	storeIdempotentResult(ctx, tx, u.ID, "file.save:"+fileID, idempotencyKey, mustMarshal(outcome))
	audit(ctx, tx, u, "file.save", "file", file.ID, "success",
		map[string]any{"versionSeq": version.Seq, "sha256": sha, "size": size, "baseSeq": baseSeq})
	if err = tx.Commit(ctx); err != nil {
		return SaveOutcome{}, err
	}
	return outcome, nil
}

// Rollback appends a new version whose bytes equal the target version, keeping
// every historical version intact (DEC-13). The immutable target blob is reused.
func (s *Service) Rollback(ctx context.Context, u domain.User, fileID string, targetSeq, expectedCurrentSeq int, lockToken, reason, idempotencyKey string) (SaveOutcome, error) {
	if targetSeq <= 0 || expectedCurrentSeq <= 0 {
		return SaveOutcome{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return SaveOutcome{}, err
	}
	defer tx.Rollback(ctx)
	if cached, ok, err := idempotentResult(ctx, tx, u.ID, "file.rollback:"+fileID, idempotencyKey); err == nil && ok {
		var outcome SaveOutcome
		if jsonErr := json.Unmarshal(cached, &outcome); jsonErr == nil {
			return outcome, nil
		}
	}
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionModify)
	if err != nil {
		return SaveOutcome{}, err
	}
	if currentSeq(file) != expectedCurrentSeq {
		return SaveOutcome{}, domain.ErrVersionConflict
	}
	if policy, found, policyErr := tx.ApprovalPolicyFor(ctx, file.FolderID); policyErr == nil && found && policy.Enabled {
		approval, submitErr := s.SubmitRollback(ctx, u, fileID, targetSeq, expectedCurrentSeq, reason)
		if submitErr != nil {
			return SaveOutcome{}, submitErr
		}
		return SaveOutcome{Approval: &approval}, nil
	}
	if err = s.requireOwnLock(ctx, tx, u, file, lockToken); err != nil {
		return SaveOutcome{}, err
	}
	target, err := tx.VersionBySeq(ctx, file.ID, targetSeq)
	if err != nil {
		return SaveOutcome{}, domain.ErrNotFound
	}
	if target.Seq >= expectedCurrentSeq {
		return SaveOutcome{}, domain.ErrVersionConflict
	}
	blob, err := tx.BlobByID(ctx, target.BlobID)
	if err != nil {
		return SaveOutcome{}, domain.ErrNotFound
	}
	version, err := s.appendVersionTx(ctx, tx, u, file, blob, target.Sha256, target.SizeBytes, domain.VersionActionRollback, new(targetSeq), reason)
	if err != nil {
		return SaveOutcome{}, err
	}
	result := SaveResult{FileID: file.ID, VersionSeq: version.Seq, Sha256: target.Sha256, Size: target.SizeBytes}
	if _, err = tx.ReleaseLock(ctx, file.ID, HashToken(lockToken)); err != nil {
		return SaveOutcome{}, err
	}
	outcome := SaveOutcome{Result: result}
	storeIdempotentResult(ctx, tx, u.ID, "file.rollback:"+fileID, idempotencyKey, mustMarshal(outcome))
	audit(ctx, tx, u, "file.rollback", "file", file.ID, "success",
		map[string]any{"versionSeq": version.Seq, "targetSeq": targetSeq, "fromSeq": expectedCurrentSeq, "reason": reason})
	if err = tx.Commit(ctx); err != nil {
		return SaveOutcome{}, err
	}
	return outcome, nil
}

func (s *Service) appendVersionTx(ctx context.Context, tx ports.Tx, u domain.User, file domain.File, blob domain.Blob, sha string, size int64, action string, targetSeq *int, reason string) (domain.FileVersion, error) {
	next, err := tx.NextVersionSeq(ctx, file.ID)
	if err != nil {
		return domain.FileVersion{}, err
	}
	version := domain.FileVersion{
		ID: NewID("ver"), FileID: file.ID, Seq: next, BlobID: blob.ID, SizeBytes: size,
		Sha256: sha, Action: action, BaseSeq: new(currentSeq(file)), CreatedBy: u.ID, Reason: reason,
	}
	if action == domain.VersionActionRollback && targetSeq != nil {
		version.RollbackTargetSeq = targetSeq
		version.RollbackFromSeq = new(currentSeq(file))
	}
	if err = tx.AppendVersion(ctx, version); err != nil {
		return domain.FileVersion{}, mapError(err)
	}
	if err = tx.UpdateCurrentVersion(ctx, file.ID, next); err != nil {
		return domain.FileVersion{}, err
	}
	return version, nil
}

func (s *Service) DeleteFile(ctx context.Context, u domain.User, fileID string) (domain.TrashEntry, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.TrashEntry{}, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionDelete)
	if err != nil {
		return domain.TrashEntry{}, err
	}
	if err = tx.SoftDeleteFile(ctx, file.ID); err != nil {
		return domain.TrashEntry{}, err
	}
	entry := domain.TrashEntry{ID: NewID("trash"), FileID: &file.ID, OldParentID: &file.FolderID, OldName: file.Name, DeletedBy: u.ID, DeletedAt: s.now()}
	if err = tx.InsertTrashEntry(ctx, entry); err != nil {
		return domain.TrashEntry{}, err
	}
	audit(ctx, tx, u, "file.delete", "file", file.ID, "success", map[string]any{"trashId": entry.ID, "name": file.Name})
	if err = tx.Commit(ctx); err != nil {
		return domain.TrashEntry{}, err
	}
	return entry, nil
}

// visibleFile loads an active file whose folder grants the requested action.
// Folder grants and folder shares resolve through require(); a file-level share
// is the fallback for directly shared files outside the caller's folder scope
// (SPEC §2.4 — the same rule the search scope CTE applies).
func (s *Service) visibleFile(ctx context.Context, repo ports.Repository, u domain.User, fileID string, action domain.Action) (domain.File, error) {
	file, err := repo.FileByID(ctx, fileID)
	if err != nil {
		return domain.File{}, domain.ErrNotFound
	}
	if file.DeletedAt != nil {
		return domain.File{}, domain.ErrNotFound
	}
	folder, err := s.activeFolder(ctx, repo, file.FolderID)
	if err != nil {
		return domain.File{}, err
	}
	if err = s.require(ctx, repo, u, folder.ID, action); err != nil {
		if !errors.Is(err, domain.ErrForbidden) {
			return domain.File{}, err
		}
		shared, shareErr := s.fileShareGrants(ctx, repo, u, fileID, action)
		if shareErr != nil {
			return domain.File{}, shareErr
		}
		if !shared {
			return domain.File{}, err
		}
	}
	return file, nil
}

func isRowMissing(err error) bool {
	return errors.Is(err, ports.ErrRowMissing)
}

func currentSeq(file domain.File) int {
	if file.CurrentVersionSeq == nil {
		return 0
	}
	return *file.CurrentVersionSeq
}

// assertNoApprovalPolicy rejects writes on folders governed by an approval
// policy until the workflow slice lands; approval-covered edits must never
// bypass review.
func (s *Service) assertNoApprovalPolicy(ctx context.Context, repo ports.Repository, folderID string) error {
	blocked, err := repo.HasActiveApprovalPolicy(ctx, folderID)
	if err != nil {
		return err
	}
	if blocked {
		return domain.ErrApprovalPending
	}
	return nil
}
