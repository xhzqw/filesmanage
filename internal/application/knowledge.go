package application

import (
	"context"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
)

type KnowledgeBlock struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Text    string `json:"text"`
	Checked bool   `json:"checked,omitempty"`
}
type KnowledgePageDetail struct {
	ports.KnowledgePage
	Files   []ports.KnowledgeFileReference `json:"files"`
	CanEdit bool                           `json:"canEdit"`
}

func validateKnowledgeBlocks(input json.RawMessage) (json.RawMessage, error) {
	if len(input) == 0 {
		return json.RawMessage("[]"), nil
	}
	if len(input) > 512*1024 {
		return nil, domain.ErrInvalidInput
	}
	var blocks []KnowledgeBlock
	if err := json.Unmarshal(input, &blocks); err != nil || blocks == nil || len(blocks) > 180 {
		return nil, domain.ErrInvalidInput
	}
	seen := map[string]bool{}
	for _, b := range blocks {
		if len(b.ID) == 0 || len(b.ID) > 85 || seen[b.ID] || len(b.Text) > 8000 {
			return nil, domain.ErrInvalidInput
		}
		seen[b.ID] = true
		switch b.Type {
		case "paragraph", "heading1", "heading2", "bullet", "todo", "quote":
		default:
			return nil, domain.ErrInvalidInput
		}
	}
	raw, e := json.Marshal(blocks)
	if e != nil {
		return nil, e
	}
	return raw, nil
}
func (s *Service) knowledgeVisible(ctx context.Context, tx ports.Tx, u domain.User, p ports.KnowledgePage) error {
	if p.OwnerID == u.ID {
		return nil
	}
	if p.FolderID == nil {
		return domain.ErrNotFound
	}
	if _, e := s.activeFolder(ctx, tx, *p.FolderID); e != nil {
		return e
	}
	return s.requireListable(ctx, tx, u, *p.FolderID)
}
func (s *Service) KnowledgeList(ctx context.Context, u domain.User) ([]ports.KnowledgePage, error) {
	tx, e := s.uow.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	repo, ok := tx.(ports.KnowledgeStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	candidate, err := repo.KnowledgeList(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	visible := make([]ports.KnowledgePage, 0, len(candidate))
	// Permission lookup is folder-scoped, not page-scoped: avoid an N+1
	// database scan for a folder containing hundreds of child pages.
	folderVisible := map[string]bool{}
	for _, p := range candidate {
		if p.OwnerID == u.ID {
			visible = append(visible, p)
			continue
		}
		if p.FolderID == nil {
			continue
		}
		allowed, known := folderVisible[*p.FolderID]
		if !known {
			_, e := s.activeFolder(ctx, tx, *p.FolderID)
			allowed = e == nil && s.requireListable(ctx, tx, u, *p.FolderID) == nil
			folderVisible[*p.FolderID] = allowed
		}
		if allowed {
			visible = append(visible, p)
		}
	}
	return visible, nil
}
func (s *Service) KnowledgeGet(ctx context.Context, u domain.User, id string) (KnowledgePageDetail, error) {
	out := KnowledgePageDetail{Files: []ports.KnowledgeFileReference{}}
	tx, e := s.uow.Begin(ctx)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	repo, ok := tx.(ports.KnowledgeStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	p, e := repo.KnowledgeByID(ctx, id)
	if errors.Is(e, ports.ErrRowMissing) {
		return out, domain.ErrNotFound
	}
	if e != nil {
		return out, e
	}
	if e = s.knowledgeVisible(ctx, tx, u, p); e != nil {
		return out, e
	}
	out.KnowledgePage = p
	out.CanEdit = p.OwnerID == u.ID
	files, e := repo.KnowledgeFiles(ctx, id)
	if e != nil {
		return out, e
	}
	for _, f := range files {
		if _, err := s.visibleFile(ctx, tx, u, f.FileID, domain.ActionPreview); err == nil {
			out.Files = append(out.Files, f)
		}
	}
	return out, nil
}

func (s *Service) KnowledgeHistory(ctx context.Context, u domain.User, id string) ([]ports.KnowledgeVersion, error) {
	tx, e := s.uow.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	repo, ok := tx.(ports.KnowledgeStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	p, e := repo.KnowledgeByID(ctx, id)
	if errors.Is(e, ports.ErrRowMissing) {
		return nil, domain.ErrNotFound
	}
	if e != nil {
		return nil, e
	}
	if e = s.knowledgeVisible(ctx, tx, u, p); e != nil {
		return nil, e
	}
	return repo.KnowledgeHistory(ctx, id)
}
func (s *Service) KnowledgeCreate(ctx context.Context, u domain.User, title string, parentID, folderID string) (ports.KnowledgePage, error) {
	var out ports.KnowledgePage
	title = strings.TrimSpace(title)
	if len(title) == 0 || len(title) > 180 {
		return out, domain.ErrInvalidInput
	}
	tx, e := s.uow.Begin(ctx)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	repo, ok := tx.(ports.KnowledgeStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	var parent *string
	var folder *string
	if parentID != "" {
		p, err := repo.KnowledgeByID(ctx, parentID)
		if errors.Is(err, ports.ErrRowMissing) {
			return out, domain.ErrNotFound
		}
		if err != nil {
			return out, err
		}
		if p.OwnerID != u.ID {
			return out, domain.ErrNotFound
		}
		if folderID != "" && (p.FolderID == nil || *p.FolderID != folderID) {
			return out, domain.ErrInvalidInput
		}
		parent = &parentID
		if p.FolderID != nil {
			folderID = *p.FolderID
		}
	}
	if folderID != "" {
		if _, err := s.activeFolder(ctx, tx, folderID); err != nil {
			return out, err
		}
		if err := s.require(ctx, tx, u, folderID, domain.ActionModify); err != nil {
			return out, err
		}
		folder = &folderID
	}
	out = ports.KnowledgePage{ID: NewID("kpage"), ParentID: parent, FolderID: folder, OwnerID: u.ID, Title: title, Blocks: json.RawMessage("[]"), Revision: 1}
	if e = repo.KnowledgeCreate(ctx, out); e != nil {
		return out, mapError(e)
	}
	if e = auditRequired(ctx, tx, u, "knowledge.page.create", "knowledge_page", out.ID, "success", map[string]any{"parentId": parentID, "folderId": folderID}); e != nil {
		return out, e
	}
	if e = tx.Commit(ctx); e != nil {
		return out, e
	}
	return out, nil
}
func (s *Service) KnowledgeUpdate(ctx context.Context, u domain.User, id, title string, blocks json.RawMessage, base int) (ports.KnowledgePage, error) {
	var out ports.KnowledgePage
	title = strings.TrimSpace(title)
	if len(title) == 0 || len(title) > 180 || base < 1 {
		return out, domain.ErrInvalidInput
	}
	cleaned, e := validateKnowledgeBlocks(blocks)
	if e != nil {
		return out, e
	}
	tx, e := s.uow.Begin(ctx)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	repo, ok := tx.(ports.KnowledgeStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	p, e := repo.KnowledgeByID(ctx, id)
	if errors.Is(e, ports.ErrRowMissing) {
		return out, domain.ErrNotFound
	}
	if e != nil {
		return out, e
	}
	if p.OwnerID != u.ID {
		return out, domain.ErrNotFound
	}
	p.Title = title
	p.Blocks = cleaned
	updated, e := repo.KnowledgeUpdate(ctx, p, base, u.ID)
	if e != nil {
		return out, e
	}
	if !updated {
		return out, domain.ErrConflict
	}
	if e = auditRequired(ctx, tx, u, "knowledge.page.update", "knowledge_page", id, "success", map[string]any{"fromRevision": base, "toRevision": base + 1}); e != nil {
		return out, e
	}
	if e = tx.Commit(ctx); e != nil {
		return out, e
	}
	p.Revision = base + 1
	return p, nil
}
func (s *Service) KnowledgeDelete(ctx context.Context, u domain.User, id string, revision int) error {
	tx, e := s.uow.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	repo, ok := tx.(ports.KnowledgeStore)
	if !ok {
		return domain.ErrInvalidInput
	}
	p, e := repo.KnowledgeByID(ctx, id)
	if errors.Is(e, ports.ErrRowMissing) {
		return domain.ErrNotFound
	}
	if e != nil {
		return e
	}
	if p.OwnerID != u.ID {
		return domain.ErrNotFound
	}
	yes, e := repo.KnowledgeDelete(ctx, id, revision)
	if e != nil {
		return e
	}
	if !yes {
		return domain.ErrConflict
	}
	if e = auditRequired(ctx, tx, u, "knowledge.page.archive", "knowledge_page", id, "success", map[string]any{"revision": revision}); e != nil {
		return e
	}
	return tx.Commit(ctx)
}

func (s *Service) KnowledgeFolderHome(ctx context.Context, u domain.User, folderID string) (string, error) {
	tx, e := s.uow.Begin(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	if _, e = s.activeFolder(ctx, tx, folderID); e != nil {
		return "", e
	}
	if e = s.requireListable(ctx, tx, u, folderID); e != nil {
		return "", e
	}
	repo, ok := tx.(ports.KnowledgeStore)
	if !ok {
		return "", domain.ErrInvalidInput
	}
	return repo.KnowledgeHome(ctx, folderID)
}
func (s *Service) KnowledgeLinkFolderHome(ctx context.Context, u domain.User, folderID, pageID string) error {
	tx, e := s.uow.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = s.activeFolder(ctx, tx, folderID); e != nil {
		return e
	}
	if e = s.require(ctx, tx, u, folderID, domain.ActionModify); e != nil {
		return e
	}
	repo, ok := tx.(ports.KnowledgeStore)
	if !ok {
		return domain.ErrInvalidInput
	}
	p, e := repo.KnowledgeByID(ctx, pageID)
	if errors.Is(e, ports.ErrRowMissing) {
		return domain.ErrNotFound
	}
	if e != nil {
		return e
	}
	if p.OwnerID != u.ID || p.FolderID == nil || *p.FolderID != folderID {
		return domain.ErrForbidden
	}
	if e = repo.KnowledgeLinkHome(ctx, folderID, pageID, u.ID); e != nil {
		return mapError(e)
	}
	if e = auditRequired(ctx, tx, u, "knowledge.folder.home.link", "folder", folderID, "success", map[string]any{"pageId": pageID, "manual": true}); e != nil {
		return e
	}
	return tx.Commit(ctx)
}

// KnowledgeUnlinkFolderHome is a separate manual operation, never a silent cleanup.
func (s *Service) KnowledgeUnlinkFolderHome(ctx context.Context, u domain.User, folderID string) error {
	tx, e := s.uow.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = s.activeFolder(ctx, tx, folderID); e != nil {
		return e
	}
	if e = s.require(ctx, tx, u, folderID, domain.ActionModify); e != nil {
		return e
	}
	repo, ok := tx.(ports.KnowledgeStore)
	if !ok {
		return domain.ErrInvalidInput
	}
	id, e := repo.KnowledgeHome(ctx, folderID)
	if e != nil {
		return e
	}
	if e = repo.KnowledgeUnlinkHome(ctx, folderID); e != nil {
		return e
	}
	if e = auditRequired(ctx, tx, u, "knowledge.folder.home.unlink", "folder", folderID, "success", map[string]any{"oldPageId": id}); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (s *Service) KnowledgeFileRef(ctx context.Context, u domain.User, pageID, fileID string, remove bool) error {
	tx, e := s.uow.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	repo, ok := tx.(ports.KnowledgeStore)
	if !ok {
		return domain.ErrInvalidInput
	}
	p, e := repo.KnowledgeByID(ctx, pageID)
	if errors.Is(e, ports.ErrRowMissing) {
		return domain.ErrNotFound
	}
	if e != nil {
		return e
	}
	if p.OwnerID != u.ID {
		return domain.ErrNotFound
	}
	if _, e = s.visibleFile(ctx, tx, u, fileID, domain.ActionPreview); e != nil {
		return e
	}
	if remove {
		e = repo.KnowledgeUnlinkFile(ctx, pageID, fileID)
	} else {
		e = repo.KnowledgeLinkFile(ctx, pageID, fileID, u.ID)
	}
	if e != nil {
		return mapError(e)
	}
	event := "knowledge.file.link"
	if remove {
		event = "knowledge.file.unlink"
	}
	if e = auditRequired(ctx, tx, u, event, "knowledge_page", pageID, "success", map[string]any{"fileId": fileID}); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (s *Service) KnowledgeBacklinks(ctx context.Context, u domain.User, fileID string) ([]ports.KnowledgeBacklink, error) {
	tx, e := s.uow.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	if _, e = s.visibleFile(ctx, tx, u, fileID, domain.ActionPreview); e != nil {
		return nil, e
	}
	repo, ok := tx.(ports.KnowledgeStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	refs, e := repo.KnowledgeFileBacklinks(ctx, fileID)
	if e != nil {
		return nil, e
	}
	out := make([]ports.KnowledgeBacklink, 0)
	for _, ref := range refs {
		if ref.OwnerID == u.ID {
			out = append(out, ref)
			continue
		}
		if ref.FolderID != nil && s.requireListable(ctx, tx, u, *ref.FolderID) == nil {
			out = append(out, ref)
		}
	}
	return out, nil
}
func (s *Service) KnowledgePageLinks(ctx context.Context, u domain.User, id string) ([]ports.KnowledgePageLink, error) {
	tx, e := s.uow.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	repo, ok := tx.(ports.KnowledgeStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	page, e := repo.KnowledgeByID(ctx, id)
	if errors.Is(e, ports.ErrRowMissing) {
		return nil, domain.ErrNotFound
	}
	if e != nil {
		return nil, e
	}
	if e = s.knowledgeVisible(ctx, tx, u, page); e != nil {
		return nil, e
	}
	related, e := repo.KnowledgePageLinks(ctx, id)
	if e != nil {
		return nil, e
	}
	visible := make([]ports.KnowledgePageLink, 0, len(related))
	for _, link := range related {
		item := ports.KnowledgePage{ID: link.PageID, OwnerID: link.OwnerID, FolderID: link.FolderID}
		if s.knowledgeVisible(ctx, tx, u, item) == nil {
			visible = append(visible, link)
		}
	}
	return visible, nil
}
func (s *Service) KnowledgePageRelation(ctx context.Context, u domain.User, source, target string, remove bool) error {
	if source == target || source == "" || target == "" {
		return domain.ErrInvalidInput
	}
	tx, e := s.uow.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	repo, ok := tx.(ports.KnowledgeStore)
	if !ok {
		return domain.ErrInvalidInput
	}
	page, e := repo.KnowledgeByID(ctx, source)
	if errors.Is(e, ports.ErrRowMissing) {
		return domain.ErrNotFound
	}
	if e != nil {
		return e
	}
	if page.OwnerID != u.ID {
		return domain.ErrNotFound
	}
	if !remove {
		targetPage, err := repo.KnowledgeByID(ctx, target)
		if errors.Is(err, ports.ErrRowMissing) {
			return domain.ErrNotFound
		}
		if err != nil {
			return err
		}
		if err = s.knowledgeVisible(ctx, tx, u, targetPage); err != nil {
			return err
		}
		e = repo.KnowledgeLinkPage(ctx, source, target, u.ID)
	} else {
		e = repo.KnowledgeUnlinkPage(ctx, source, target)
	}
	if e != nil {
		return mapError(e)
	}
	kind := "knowledge.page.link"
	if remove {
		kind = "knowledge.page.unlink"
	}
	if e = auditRequired(ctx, tx, u, kind, "knowledge_page", source, "success", map[string]any{"targetPageId": target}); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
