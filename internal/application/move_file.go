package application

import (
	"context"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"fmt"
	"sort"
	"strings"
)

// File move use cases implement the COMPLEX-WORKFLOWS §3 end-to-end contract:
// the committed single-file move (draft B), the all-or-nothing batch commit
// (draft C), and the read-only preflight (draft A).
// The preflight is UX only and never an authorization proof; the commit
// transactions re-verify the source move action, the target upload action,
// the target's active state, name uniqueness and the CAS guard.

type MoveResult struct {
	FileID       string
	FromFolderID string
	ToFolderID   string
}

// MoveFile moves one active file into another active folder inside a single
// transaction. expectedFolderID is a CAS guard: a stale value rejects the move
// with E_VERSION_CONFLICT instead of silently relocating the file. The
// idempotency key replays the recorded result without a second move or audit
// row, exactly like Save and Rollback.
func (s *Service) MoveFile(ctx context.Context, u domain.User, fileID, targetFolderID, expectedFolderID, idempotencyKey string) (MoveResult, error) {
	if targetFolderID == "" {
		return MoveResult{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return MoveResult{}, err
	}
	defer tx.Rollback(ctx)
	if cached, ok, err := idempotentResult(ctx, tx, u.ID, "file.move:"+fileID, idempotencyKey); err == nil && ok {
		var result MoveResult
		if jsonErr := json.Unmarshal(cached, &result); jsonErr == nil {
			return result, nil
		}
	}
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionMove)
	if err != nil {
		return MoveResult{}, err
	}
	if expectedFolderID != "" && file.FolderID != expectedFolderID {
		return MoveResult{}, domain.ErrVersionConflict
	}
	if file.FolderID == targetFolderID {
		return MoveResult{}, domain.ErrMoveConflict
	}
	target, err := s.activeFolder(ctx, tx, targetFolderID)
	if err != nil {
		return MoveResult{}, err
	}
	if err = s.require(ctx, tx, u, target.ID, domain.ActionUpload); err != nil {
		return MoveResult{}, err
	}
	if _, err = tx.FileByNameInFolder(ctx, target.ID, file.Name); err == nil {
		return MoveResult{}, domain.ErrNameConflict
	} else if !isRowMissing(err) {
		return MoveResult{}, err
	}
	fromPath, err := historicalFolderPath(ctx, tx, file.FolderID)
	if err != nil {
		return MoveResult{}, err
	}
	toPath, err := historicalFolderPath(ctx, tx, target.ID)
	if err != nil {
		return MoveResult{}, err
	}
	if err = tx.MoveFile(ctx, file.ID, target.ID); err != nil {
		return MoveResult{}, mapError(err)
	}
	result := MoveResult{FileID: file.ID, FromFolderID: file.FolderID, ToFolderID: target.ID}
	storeIdempotentResult(ctx, tx, u.ID, "file.move:"+fileID, idempotencyKey, mustMarshal(result))
	if err = auditRequired(ctx, tx, u, "file.move", "file", file.ID, "success",
		map[string]any{"fromFolderId": file.FolderID, "toFolderId": target.ID, "fromPath": fromPath, "toPath": toPath, "name": file.Name}); err != nil {
		return MoveResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MoveResult{}, err
	}
	// Authorisation just changed: drop every cached read so the next
	// request sees the new scope (PE04).
	s.bumpACLEpoch()
	return result, nil
}

// MaxMoveBatchFiles bounds one all-or-nothing batch move. The whole batch runs
// in a single transaction (ADR-UX-02 / COMPLEX-WORKFLOWS §3.1), so the cap keeps
// the transaction's validation work and row locks bounded; an over-limit request
// is rejected with ErrBatchTooLarge before any database work.
const MaxMoveBatchFiles = 100

// ErrBatchTooLarge rejects a fileIds list over MaxMoveBatchFiles. It answers the
// 400 E_BAD class of other invalid input (its Is hook keeps errors.Is against
// domain.ErrInvalidInput true) and its message states the limit.
var ErrBatchTooLarge error = batchTooLargeError{}

type batchTooLargeError struct{}

func (batchTooLargeError) Error() string {
	return fmt.Sprintf("fileIds exceeds the batch limit of %d", MaxMoveBatchFiles)
}

func (batchTooLargeError) Is(target error) bool { return target == domain.ErrInvalidInput }

// MoveBatchResult is the outcome of one batch move. Status is "committed" when
// every file moved (Moved lists them in request order) or "conflict" when at
// least one item failed validation: nothing was written then, Moved is empty and
// Conflicts lists every failure with the same stable codes the single-file path
// answers. Count is the number of files moved on commit, and the number of
// reported conflicts otherwise.
type MoveBatchResult struct {
	Status    string
	Moved     []MoveResult
	Conflicts []MoveConflict
	Count     int
}

const (
	moveBatchCommitted = "committed"
	moveBatchConflict  = "conflict"
)

// addConflict records one per-item failure. The aggregate status flips to
// "conflict" after the validation loop when at least one entry exists.
func (r *MoveBatchResult) addConflict(c MoveConflict) {
	r.Conflicts = append(r.Conflicts, c)
}

// MoveFilesBatch moves many files into one active folder inside a single
// transaction (COMPLEX-WORKFLOWS §3.2 draft C). Every item is validated with the
// same checks MoveFile performs - source move, target active and upload, same
// folder and target name uniqueness - before the first write; any failure leaves
// nothing written (no move, no audit row) and answers a per-item conflict list so
// the caller can exclude failing items and retry. A repeated idempotency key
// replays the recorded committed result without a second move or audit rows.
//
// The batch has no CAS field: expectedFolderId is a single-file guard and has no
// well-defined batch meaning. Concurrent moves are caught by the target's live
// name uniqueness and, finally, by the database unique index at commit time.
func (s *Service) MoveFilesBatch(ctx context.Context, u domain.User, fileIDs []string, targetFolderID, mode, idempotencyKey string) (MoveBatchResult, error) {
	if len(fileIDs) == 0 || targetFolderID == "" {
		return MoveBatchResult{}, domain.ErrInvalidInput
	}
	if mode != "" && mode != "all_or_nothing" {
		return MoveBatchResult{}, domain.ErrInvalidInput
	}
	if len(fileIDs) > MaxMoveBatchFiles {
		return MoveBatchResult{}, ErrBatchTooLarge
	}
	seen := make(map[string]bool, len(fileIDs))
	for _, fileID := range fileIDs {
		if fileID == "" || seen[fileID] {
			return MoveBatchResult{}, domain.ErrInvalidInput
		}
		seen[fileID] = true
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return MoveBatchResult{}, err
	}
	defer tx.Rollback(ctx)
	operation := moveBatchOperation(fileIDs)
	if cached, ok, cacheErr := idempotentResult(ctx, tx, u.ID, operation, idempotencyKey); cacheErr == nil && ok {
		var result MoveBatchResult
		if jsonErr := json.Unmarshal(cached, &result); jsonErr == nil {
			return result, nil
		}
	}
	// The target verdict is identical for every item, so resolve it once and
	// still apply it per item in MoveFile's check order.
	target, targetErr := s.activeFolder(ctx, tx, targetFolderID)
	targetForbidden := false
	if targetErr == nil {
		if err = s.require(ctx, tx, u, target.ID, domain.ActionUpload); err != nil {
			if !errors.Is(err, domain.ErrForbidden) {
				return MoveBatchResult{}, err
			}
			targetForbidden = true
		}
	}
	result := MoveBatchResult{Status: moveBatchCommitted, Moved: []MoveResult{}, Conflicts: []MoveConflict{}}
	movedNames := make([]string, 0, len(fileIDs))
	names := make(map[string]bool, len(fileIDs))
	for _, fileID := range fileIDs {
		file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionMove)
		if err != nil {
			if errors.Is(err, domain.ErrNotFound) {
				result.addConflict(MoveConflict{ID: fileID, Code: "E_NOT_FOUND", Message: "资源不存在或不可见"})
				continue
			}
			if errors.Is(err, domain.ErrForbidden) {
				result.addConflict(MoveConflict{ID: fileID, Code: "E_FORBIDDEN", Message: "来源目录缺少 move 权限"})
				continue
			}
			return MoveBatchResult{}, err
		}
		if file.FolderID == targetFolderID {
			result.addConflict(MoveConflict{ID: fileID, Code: "E_MOVE_CONFLICT", Message: "文件已在目标目录"})
			continue
		}
		if targetErr != nil {
			result.addConflict(MoveConflict{ID: fileID, Code: "E_NOT_FOUND", Message: "目标目录不存在或不可见"})
			continue
		}
		if targetForbidden {
			result.addConflict(MoveConflict{ID: fileID, Code: "E_FORBIDDEN", Message: "目标目录缺少 upload 权限"})
			continue
		}
		// names also catches two batch entries that would land as the same live
		// name in the target: the later entry conflicts instead of racing the
		// database unique index mid-commit.
		if _, nameErr := tx.FileByNameInFolder(ctx, target.ID, file.Name); nameErr == nil || names[file.Name] {
			result.addConflict(MoveConflict{ID: fileID, Code: "E_NAME_CONFLICT", Message: "目标目录已存在同名文件"})
			continue
		} else if !isRowMissing(nameErr) {
			return MoveBatchResult{}, nameErr
		}
		names[file.Name] = true
		movedNames = append(movedNames, file.Name)
		result.Moved = append(result.Moved, MoveResult{FileID: file.ID, FromFolderID: file.FolderID, ToFolderID: target.ID})
	}
	if len(result.Conflicts) > 0 {
		// All-or-nothing: return the per-item verdicts and let the deferred
		// rollback end the transaction without a single write.
		result.Status = moveBatchConflict
		result.Moved = []MoveResult{}
		result.Count = len(result.Conflicts)
		return result, nil
	}
	pathCache := map[string]string{}
	pathFor := func(id string) (string, error) {
		if path, ok := pathCache[id]; ok {
			return path, nil
		}
		path, e := historicalFolderPath(ctx, tx, id)
		if e == nil {
			pathCache[id] = path
		}
		return path, e
	}
	for i, moved := range result.Moved {
		fromPath, pathErr := pathFor(moved.FromFolderID)
		if pathErr != nil {
			return MoveBatchResult{}, pathErr
		}
		toPath, pathErr := pathFor(moved.ToFolderID)
		if pathErr != nil {
			return MoveBatchResult{}, pathErr
		}
		if err = tx.MoveFile(ctx, moved.FileID, moved.ToFolderID); err != nil {
			return MoveBatchResult{}, mapError(err)
		}
		if err = auditRequired(ctx, tx, u, "file.move", "file", moved.FileID, "success",
			map[string]any{"fromFolderId": moved.FromFolderID, "toFolderId": moved.ToFolderID, "fromPath": fromPath, "toPath": toPath, "name": movedNames[i]}); err != nil {
			return MoveBatchResult{}, err
		}
	}
	result.Count = len(result.Moved)
	storeIdempotentResult(ctx, tx, u.ID, operation, idempotencyKey, mustMarshal(result))
	if err = tx.Commit(ctx); err != nil {
		return MoveBatchResult{}, err
	}
	// The batch changed the tree scope: drop every cached read (PE04).
	s.bumpACLEpoch()
	return result, nil
}

// moveBatchOperation scopes the single idempotency record to the exact file set
// of the request - the same convention as the single-file "file.move:"+fileID
// key - so a repeated key carries the same operation regardless of request order.
func moveBatchOperation(fileIDs []string) string {
	sorted := append([]string(nil), fileIDs...)
	sort.Strings(sorted)
	return "file.move-batch:" + strings.Join(sorted, ",")
}

// MoveResource references one resource under preflight; only files are
// committed by this slice.
type MoveResource struct {
	Kind string
	ID   string
}

// MoveConflict is one per-resource preflight failure. Codes are the stable
// envelope codes the commit path would answer for the same condition.
type MoveConflict struct {
	ID      string
	Code    string
	Message string
}

// MovePreflight is the read-only UX pre-check result (draft A).
// candidateRevision is opaque and carries no authorization: the commit path
// re-verifies every decision. Summaries only ever name folders the caller may
// see, so a hidden ancestor truncates the path instead of leaking its name.
type MovePreflight struct {
	Status            string
	CandidateRevision string
	AllowedCount      int
	Conflicts         []MoveConflict
	Warnings          []string
	SourceSummary     string
	TargetSummary     string
}

const (
	movePreflightReady     = "ready"
	movePreflightConflict  = "conflict"
	movePreflightForbidden = "forbidden"
)

// PreflightMove checks visibility, move/upload permissions and name conflicts
// for a candidate move without writing anything. A target the caller cannot
// see answers E_NOT_FOUND exactly like a missing one, so probing cannot
// distinguish "hidden" from "missing" (SAFE-04).
func (s *Service) PreflightMove(ctx context.Context, u domain.User, resources []MoveResource, targetFolderID, mode string) (MovePreflight, error) {
	if len(resources) == 0 || targetFolderID == "" {
		return MovePreflight{}, domain.ErrInvalidInput
	}
	if mode != "" && mode != "all_or_nothing" {
		return MovePreflight{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return MovePreflight{}, err
	}
	defer tx.Rollback(ctx)
	target, err := s.activeFolder(ctx, tx, targetFolderID)
	if err != nil {
		return MovePreflight{}, err
	}
	targetVisible, err := s.folderListable(ctx, tx, u, target.ID)
	if err != nil {
		return MovePreflight{}, err
	}
	if !targetVisible {
		return MovePreflight{}, domain.ErrNotFound
	}
	targetUpload := s.require(ctx, tx, u, target.ID, domain.ActionUpload) == nil
	out := MovePreflight{
		Status:            movePreflightReady,
		CandidateRevision: NewID("mrev"),
		Warnings:          []string{"目标目录继承权限将重新评估"},
		TargetSummary:     s.visiblePath(ctx, tx, u, target.ID),
	}
	sources := make([]string, 0, len(resources))
	seenSource := map[string]bool{}
	// Each source folder may legally contain a file with the same name. Those
	// files cannot both land in one target, even when that target is empty.
	// Mirror MoveFilesBatch's intra-request uniqueness check during preflight.
	seenTargetNames := map[string]bool{}
	for _, res := range resources {
		if res.Kind != "file" {
			out.addConflict(MoveConflict{ID: res.ID, Code: "E_BAD", Message: "不支持的资源类型"})
			continue
		}
		file, err := tx.FileByID(ctx, res.ID)
		if err != nil || file.DeletedAt != nil {
			out.addConflict(MoveConflict{ID: res.ID, Code: "E_NOT_FOUND", Message: "资源不存在或不可见"})
			continue
		}
		sourceVisible, err := s.folderListable(ctx, tx, u, file.FolderID)
		if err != nil {
			return MovePreflight{}, err
		}
		if !sourceVisible {
			out.addConflict(MoveConflict{ID: res.ID, Code: "E_NOT_FOUND", Message: "资源不存在或不可见"})
			continue
		}
		if s.require(ctx, tx, u, file.FolderID, domain.ActionMove) != nil {
			out.addConflict(MoveConflict{ID: res.ID, Code: "E_FORBIDDEN", Message: "来源目录缺少 move 权限"})
			continue
		}
		if !targetUpload {
			out.addConflict(MoveConflict{ID: res.ID, Code: "E_FORBIDDEN", Message: "目标目录缺少 upload 权限"})
			continue
		}
		if file.FolderID == target.ID {
			out.addConflict(MoveConflict{ID: res.ID, Code: "E_MOVE_CONFLICT", Message: "文件已在目标目录"})
			continue
		}
		if _, err = tx.FileByNameInFolder(ctx, target.ID, file.Name); err == nil {
			out.addConflict(MoveConflict{ID: res.ID, Code: "E_NAME_CONFLICT", Message: "目标目录已存在同名文件"})
			continue
		} else if !isRowMissing(err) {
			return MovePreflight{}, err
		}
		if seenTargetNames[file.Name] {
			out.addConflict(MoveConflict{ID: res.ID, Code: "E_NAME_CONFLICT", Message: "所选文件存在重名，无法同时移动到同一目录"})
			continue
		}
		seenTargetNames[file.Name] = true
		out.AllowedCount++
		if !seenSource[file.FolderID] {
			seenSource[file.FolderID] = true
			sources = append(sources, s.visiblePath(ctx, tx, u, file.FolderID))
		}
	}
	out.SourceSummary = strings.Join(sources, "; ")
	return out, nil
}

// addConflict records a per-resource failure and keeps the aggregate status:
// any forbidden entry dominates, otherwise conflicts report "conflict".
func (p *MovePreflight) addConflict(c MoveConflict) {
	p.Conflicts = append(p.Conflicts, c)
	if c.Code == "E_FORBIDDEN" {
		p.Status = movePreflightForbidden
		return
	}
	if p.Status != movePreflightForbidden {
		p.Status = movePreflightConflict
	}
}

// folderListable reports whether the caller holds the list action on the
// folder, which is the visibility rule every tree, list and search read uses.
func (s *Service) folderListable(ctx context.Context, repo ports.Repository, u domain.User, folderID string) (bool, error) {
	return newFolderReadView(s, repo, u).listable(ctx, folderID)
}

// visiblePath renders the " / "-joined folder names from the root down to
// folderID, stopping at the first ancestor the caller may not list so a hidden
// branch never leaks its name or the path above it.
func (s *Service) visiblePath(ctx context.Context, repo ports.Repository, u domain.User, folderID string) string {
	return newFolderReadView(s, repo, u).path(ctx, folderID)
}
