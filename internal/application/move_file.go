package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
)

// File move use cases implement the COMPLEX-WORKFLOWS §3 end-to-end contract:
// the committed single-file move (draft B) and the read-only preflight (draft A).
// The preflight is UX only and never an authorization proof; the commit
// transaction re-verifies the source move action, the target upload action,
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
	if err = tx.MoveFile(ctx, file.ID, target.ID); err != nil {
		return MoveResult{}, mapError(err)
	}
	result := MoveResult{FileID: file.ID, FromFolderID: file.FolderID, ToFolderID: target.ID}
	storeIdempotentResult(ctx, tx, u.ID, "file.move:"+fileID, idempotencyKey, mustMarshal(result))
	audit(ctx, tx, u, "file.move", "file", file.ID, "success",
		map[string]any{"fromFolderId": file.FolderID, "toFolderId": target.ID, "name": file.Name})
	if err = tx.Commit(ctx); err != nil {
		return MoveResult{}, err
	}
	// Authorisation just changed: drop every cached read so the next
	// request sees the new scope (PE04).
	s.bumpACLEpoch()
	return result, nil
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
	actions, err := s.resolveActions(ctx, repo, u, folderID)
	if err != nil {
		return false, err
	}
	return actions[domain.ActionList], nil
}

// visiblePath renders the " / "-joined folder names from the root down to
// folderID, stopping at the first ancestor the caller may not list so a hidden
// branch never leaks its name or the path above it.
func (s *Service) visiblePath(ctx context.Context, repo ports.Repository, u domain.User, folderID string) string {
	names := make([]string, 0, 8)
	current := folderID
	for depth := 0; depth <= 64 && current != ""; depth++ {
		folder, err := repo.FolderByID(ctx, current)
		if err != nil {
			break
		}
		listable, err := s.folderListable(ctx, repo, u, folder.ID)
		if err != nil || !listable {
			break
		}
		names = append(names, folder.Name)
		if folder.ParentID == nil {
			break
		}
		current = *folder.ParentID
	}
	for i, j := 0, len(names)-1; i < j; i, j = i+1, j-1 {
		names[i], names[j] = names[j], names[i]
	}
	return strings.Join(names, " / ")
}
