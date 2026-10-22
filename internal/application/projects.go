package application

import (
	"context"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// The project database is a cross-department register, not a document: reads
// are open to every signed-in employee, writes follow the same admin-only rule
// the rest of the workbench mutations use (CDW tasks, DHF projects).

const (
	projectNameMax        = 120
	projectDescriptionMax = 4000
	projectCommentMax     = 2000
	projectTodoMax        = 500
	projectDocNameMax     = 300
	projectDocIDMax       = 200
	projectDocBatchMax    = 200
	projectViewKey        = "projects"
	projectViewMaxBytes   = 16384
	projectDateLayout     = "2006-01-02"
)

var (
	projectIcons      = map[string]bool{"◇": true, "◈": true, "▦": true, "✦": true, "◎": true}
	projectStatuses   = map[string]bool{"notstarted": true, "progress": true, "done": true}
	projectPriorities = map[string]bool{"high": true, "mid": true, "low": true}
	projectTeams      = map[string]bool{"": true, "销售部": true, "产品设计": true, "人力资源": true, "供应链": true, "工程部": true, "文件管理": true}
	projectDocKinds   = map[string]bool{"gdrive": true, "pdf": true, "figma": true, "file": true}
)

// ProjectPage mirrors the frontend ProjectPage: asOf is mandatory there, so it
// is always set even when the page is empty.
type ProjectPage struct {
	Items      []ports.Project `json:"items"`
	NextCursor *string         `json:"nextCursor"`
	AsOf       string          `json:"asOf"`
}

// ProjectWriteInput is the create payload. PATCH reuses the pointer variant
// below so an absent field stays absent instead of being zeroed.
type ProjectWriteInput struct {
	Name        string  `json:"name"`
	Icon        string  `json:"icon"`
	Description string  `json:"description"`
	Status      string  `json:"status"`
	Priority    string  `json:"priority"`
	Team        string  `json:"team"`
	OwnerID     string  `json:"ownerId"`
	Progress    *int    `json:"progress"`
	StartDate   *string `json:"startDate"`
	EndDate     *string `json:"endDate"`
}

// ProjectPatch is a shallow merge: only non-nil members are applied.
type ProjectPatch struct {
	Name        *string `json:"name"`
	Icon        *string `json:"icon"`
	Description *string `json:"description"`
	Status      *string `json:"status"`
	Priority    *string `json:"priority"`
	Team        *string `json:"team"`
	OwnerID     *string `json:"ownerId"`
	Progress    *int    `json:"progress"`
	StartDate   *string `json:"startDate"`
	EndDate     *string `json:"endDate"`
	Archived    *bool   `json:"archived"`
	Favorite    *bool   `json:"favorite"`
}

func validProjectText(v string, max int) bool {
	return utf8.ValidString(v) && utf8.RuneCountInString(v) <= max
}

// parseProjectDate accepts "" and null (both mean "unset") plus a real
// calendar date. Time-of-day and timezone suffixes are rejected: the field is
// a date, and a silently truncated timestamp would move the gantt bar.
func parseProjectDate(v string) (*time.Time, bool) {
	if v == "" {
		return nil, true
	}
	parsed, err := time.Parse(projectDateLayout, v)
	if err != nil {
		return nil, false
	}
	return &parsed, true
}

// validateProject applies the shared invariants. It normalizes in place and
// returns false on any violation so the handler answers E_INVALID_INPUT.
func validateProject(p *ports.Project) bool {
	p.Name = strings.TrimSpace(p.Name)
	p.Description = strings.TrimSpace(p.Description)
	p.OwnerID = strings.TrimSpace(p.OwnerID)
	if p.Icon == "" {
		p.Icon = "◇"
	}
	if p.Status == "" {
		p.Status = "notstarted"
	}
	if p.Priority == "" {
		p.Priority = "mid"
	}
	if !validProjectText(p.Name, projectNameMax) || p.Name == "" {
		return false
	}
	if !projectIcons[p.Icon] || !projectStatuses[p.Status] || !projectPriorities[p.Priority] || !projectTeams[p.Team] {
		return false
	}
	if !validProjectText(p.Description, projectDescriptionMax) || !validProjectText(p.OwnerID, 200) {
		return false
	}
	if p.Progress < 0 || p.Progress > 100 {
		return false
	}
	if p.StartDate != nil && p.EndDate != nil && p.EndDate.Before(*p.StartDate) {
		return false
	}
	return true
}

func (s *Service) projectStore(tx ports.Repository) (ports.ProjectStore, error) {
	store, ok := tx.(ports.ProjectStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	return store, nil
}

// projectWritable enforces the admin-only write rule documented in
// SPEC-project-db §3.4; reads stay open to every authenticated user.
func projectWritable(actor domain.User) error {
	if !actor.IsAdmin {
		return domain.ErrForbidden
	}
	return nil
}

func (s *Service) ProjectList(ctx context.Context, actor domain.User) (ProjectPage, error) {
	page := ProjectPage{Items: []ports.Project{}, AsOf: s.now().UTC().Format(time.RFC3339)}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return page, err
	}
	defer tx.Rollback(ctx)
	store, err := s.projectStore(tx)
	if err != nil {
		return page, err
	}
	items, err := store.ProjectList(ctx)
	if err != nil {
		return page, err
	}
	if items != nil {
		page.Items = items
	}
	return page, nil
}

func (s *Service) ProjectGet(ctx context.Context, actor domain.User, id int64) (ports.Project, error) {
	if id < 1 {
		return ports.Project{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return ports.Project{}, err
	}
	defer tx.Rollback(ctx)
	store, err := s.projectStore(tx)
	if err != nil {
		return ports.Project{}, err
	}
	return store.ProjectByID(ctx, id, false)
}

func (s *Service) ProjectCreate(ctx context.Context, actor domain.User, in ProjectWriteInput) (ports.Project, error) {
	if err := projectWritable(actor); err != nil {
		return ports.Project{}, err
	}
	progress := 0
	if in.Progress != nil {
		progress = *in.Progress
	}
	project := ports.Project{
		Name: in.Name, Icon: in.Icon, Description: in.Description, Status: in.Status,
		Priority: in.Priority, Team: in.Team, OwnerID: in.OwnerID, Progress: progress,
		CreatedBy: actor.ID,
	}
	start, ok := parseProjectDate(derefString(in.StartDate))
	if !ok {
		return ports.Project{}, domain.ErrInvalidInput
	}
	end, ok := parseProjectDate(derefString(in.EndDate))
	if !ok {
		return ports.Project{}, domain.ErrInvalidInput
	}
	project.StartDate, project.EndDate = start, end
	if !validateProject(&project) {
		return ports.Project{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return ports.Project{}, err
	}
	defer tx.Rollback(ctx)
	store, err := s.projectStore(tx)
	if err != nil {
		return ports.Project{}, err
	}
	if project.OwnerID != "" {
		active, ownerErr := tx.UserExists(ctx, project.OwnerID)
		if ownerErr != nil {
			return ports.Project{}, ownerErr
		}
		if !active {
			return ports.Project{}, domain.ErrInvalidInput
		}
	}
	created, err := store.ProjectCreate(ctx, project)
	if err != nil {
		return ports.Project{}, err
	}
	if err = auditRequired(ctx, tx, actor, "project.create", "project", strconv.FormatInt(created.ID, 10), "success",
		map[string]any{"name": created.Name}); err != nil {
		return ports.Project{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ports.Project{}, err
	}
	return created, nil
}

// ProjectUpdate shallow-merges the patch onto the stored record. It runs in one
// transaction and re-reads the row with FOR UPDATE so two inline edits (status
// from a board drag, dates from a gantt drag) cannot lose each other.
func (s *Service) ProjectUpdate(ctx context.Context, actor domain.User, id int64, patch ProjectPatch) (ports.Project, error) {
	if err := projectWritable(actor); err != nil {
		return ports.Project{}, err
	}
	if id < 1 {
		return ports.Project{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return ports.Project{}, err
	}
	defer tx.Rollback(ctx)
	store, err := s.projectStore(tx)
	if err != nil {
		return ports.Project{}, err
	}
	current, err := store.ProjectByID(ctx, id, true)
	if err != nil {
		return ports.Project{}, err
	}
	// Archived rows are hidden from the list but still editable: un-archiving
	// goes through this same PATCH.
	if patch.Name != nil {
		current.Name = *patch.Name
	}
	if patch.Icon != nil {
		current.Icon = *patch.Icon
	}
	if patch.Description != nil {
		current.Description = *patch.Description
	}
	if patch.Status != nil {
		current.Status = *patch.Status
	}
	if patch.Priority != nil {
		current.Priority = *patch.Priority
	}
	if patch.Team != nil {
		current.Team = *patch.Team
	}
	if patch.OwnerID != nil {
		current.OwnerID = *patch.OwnerID
	}
	if patch.Progress != nil {
		current.Progress = *patch.Progress
	}
	if patch.StartDate != nil {
		start, ok := parseProjectDate(*patch.StartDate)
		if !ok {
			return ports.Project{}, domain.ErrInvalidInput
		}
		current.StartDate = start
	}
	if patch.EndDate != nil {
		end, ok := parseProjectDate(*patch.EndDate)
		if !ok {
			return ports.Project{}, domain.ErrInvalidInput
		}
		current.EndDate = end
	}
	if patch.Favorite != nil {
		current.Favorite = *patch.Favorite
	}
	if patch.Archived != nil {
		current.Archived = *patch.Archived
	}
	if !validateProject(&current) {
		return ports.Project{}, domain.ErrInvalidInput
	}
	if current.OwnerID != "" {
		active, ownerErr := tx.UserExists(ctx, current.OwnerID)
		if ownerErr != nil {
			return ports.Project{}, ownerErr
		}
		if !active {
			return ports.Project{}, domain.ErrInvalidInput
		}
	}
	updated, err := store.ProjectUpdate(ctx, current)
	if err != nil {
		return ports.Project{}, err
	}
	if err = auditRequired(ctx, tx, actor, "project.update", "project", strconv.FormatInt(id, 10), "success",
		map[string]any{"archived": updated.Archived, "status": updated.Status}); err != nil {
		return ports.Project{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ports.Project{}, err
	}
	return updated, nil
}

// ProjectDelete soft-deletes: the row is archived and every sub-resource is
// kept, so history stays readable and the id is never reused.
func (s *Service) ProjectDelete(ctx context.Context, actor domain.User, id int64) error {
	if err := projectWritable(actor); err != nil {
		return err
	}
	if id < 1 {
		return domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	store, err := s.projectStore(tx)
	if err != nil {
		return err
	}
	if _, err = store.ProjectByID(ctx, id, true); err != nil {
		return err
	}
	if err = store.ProjectSetArchived(ctx, id, true); err != nil {
		return err
	}
	if err = auditRequired(ctx, tx, actor, "project.delete", "project", strconv.FormatInt(id, 10), "success", nil); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}

func (s *Service) ProjectAddComment(ctx context.Context, actor domain.User, id int64, text string) (ports.ProjectComment, error) {
	if err := projectWritable(actor); err != nil {
		return ports.ProjectComment{}, err
	}
	text = strings.TrimSpace(text)
	if id < 1 || text == "" || !validProjectText(text, projectCommentMax) {
		return ports.ProjectComment{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return ports.ProjectComment{}, err
	}
	defer tx.Rollback(ctx)
	store, err := s.projectStore(tx)
	if err != nil {
		return ports.ProjectComment{}, err
	}
	if _, err = store.ProjectByID(ctx, id, false); err != nil {
		return ports.ProjectComment{}, err
	}
	comment, err := store.ProjectAddComment(ctx, ports.ProjectComment{ProjectID: id, AuthorID: actor.ID, Author: actor.DisplayName, Body: text})
	if err != nil {
		return ports.ProjectComment{}, err
	}
	if err = store.ProjectTouch(ctx, id); err != nil {
		return ports.ProjectComment{}, err
	}
	if err = auditRequired(ctx, tx, actor, "project.comment", "project", strconv.FormatInt(id, 10), "success", nil); err != nil {
		return ports.ProjectComment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ports.ProjectComment{}, err
	}
	return comment, nil
}

func (s *Service) ProjectAddTodo(ctx context.Context, actor domain.User, id int64, text string) (ports.ProjectTodo, error) {
	if err := projectWritable(actor); err != nil {
		return ports.ProjectTodo{}, err
	}
	text = strings.TrimSpace(text)
	if id < 1 || text == "" || !validProjectText(text, projectTodoMax) {
		return ports.ProjectTodo{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return ports.ProjectTodo{}, err
	}
	defer tx.Rollback(ctx)
	store, err := s.projectStore(tx)
	if err != nil {
		return ports.ProjectTodo{}, err
	}
	if _, err = store.ProjectByID(ctx, id, false); err != nil {
		return ports.ProjectTodo{}, err
	}
	todo, err := store.ProjectAddTodo(ctx, ports.ProjectTodo{ProjectID: id, Body: text})
	if err != nil {
		return ports.ProjectTodo{}, err
	}
	if err = store.ProjectTouch(ctx, id); err != nil {
		return ports.ProjectTodo{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ports.ProjectTodo{}, err
	}
	return todo, nil
}

func (s *Service) ProjectSetTodoDone(ctx context.Context, actor domain.User, id, todoID int64, done bool) error {
	if err := projectWritable(actor); err != nil {
		return err
	}
	if id < 1 || todoID < 1 {
		return domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	store, err := s.projectStore(tx)
	if err != nil {
		return err
	}
	found, err := store.ProjectSetTodoDone(ctx, id, todoID, done)
	if err != nil {
		return err
	}
	if !found {
		return domain.ErrNotFound
	}
	if err = store.ProjectTouch(ctx, id); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}

func (s *Service) ProjectDeleteTodo(ctx context.Context, actor domain.User, id, todoID int64) error {
	if err := projectWritable(actor); err != nil {
		return err
	}
	if id < 1 || todoID < 1 {
		return domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	store, err := s.projectStore(tx)
	if err != nil {
		return err
	}
	found, err := store.ProjectDeleteTodo(ctx, id, todoID)
	if err != nil {
		return err
	}
	if !found {
		return domain.ErrNotFound
	}
	if err = store.ProjectTouch(ctx, id); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}

func validProjectDoc(d ports.ProjectDoc) bool {
	d.DocID = strings.TrimSpace(d.DocID)
	d.Name = strings.TrimSpace(d.Name)
	return d.DocID != "" && validProjectText(d.DocID, projectDocIDMax) &&
		d.Name != "" && validProjectText(d.Name, projectDocNameMax) && projectDocKinds[d.Kind]
}

// ProjectAddDocs links documents in one transaction. Existing links are skipped
// idempotently, so the picker's "already attached" race cannot fail a batch.
func (s *Service) ProjectAddDocs(ctx context.Context, actor domain.User, id int64, docs []ports.ProjectDoc) (int, error) {
	if err := projectWritable(actor); err != nil {
		return 0, err
	}
	if id < 1 || len(docs) == 0 || len(docs) > projectDocBatchMax {
		return 0, domain.ErrInvalidInput
	}
	clean := make([]ports.ProjectDoc, 0, len(docs))
	seen := make(map[string]bool, len(docs))
	for _, doc := range docs {
		if !validProjectDoc(doc) {
			return 0, domain.ErrInvalidInput
		}
		if seen[doc.DocID] {
			continue
		}
		seen[doc.DocID] = true
		clean = append(clean, ports.ProjectDoc{DocID: doc.DocID, Name: doc.Name, Kind: doc.Kind})
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	store, err := s.projectStore(tx)
	if err != nil {
		return 0, err
	}
	if _, err = store.ProjectByID(ctx, id, false); err != nil {
		return 0, err
	}
	added, err := store.ProjectUpsertDocs(ctx, id, clean)
	if err != nil {
		return 0, err
	}
	if err = store.ProjectTouch(ctx, id); err != nil {
		return 0, err
	}
	if err = auditRequired(ctx, tx, actor, "project.docs.link", "project", strconv.FormatInt(id, 10), "success",
		map[string]any{"added": added, "requested": len(clean)}); err != nil {
		return 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	return added, nil
}

func (s *Service) ProjectRemoveDoc(ctx context.Context, actor domain.User, id int64, docID string) error {
	if err := projectWritable(actor); err != nil {
		return err
	}
	docID = strings.TrimSpace(docID)
	if id < 1 || docID == "" || !validProjectText(docID, projectDocIDMax) {
		return domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	store, err := s.projectStore(tx)
	if err != nil {
		return err
	}
	found, err := store.ProjectDeleteDoc(ctx, id, docID)
	if err != nil {
		return err
	}
	if !found {
		return domain.ErrNotFound
	}
	if err = store.ProjectTouch(ctx, id); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}

// ProjectViewState reads the caller's own saved view. A missing row is not an
// error: the frontend falls back to its defaults.
func (s *Service) ProjectViewState(ctx context.Context, actor domain.User) (json.RawMessage, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, err := s.projectStore(tx)
	if err != nil {
		return nil, err
	}
	raw, err := store.ProjectViewState(ctx, actor.ID, projectViewKey)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) || errors.Is(err, ports.ErrRowMissing) {
			return nil, nil
		}
		return nil, err
	}
	return raw, nil
}

// ProjectPutViewState stores the whole view object for this user. The payload
// must be a JSON object; deeper validation is the frontend's contract, and an
// opaque object keeps new keys from needing a migration.
func (s *Service) ProjectPutViewState(ctx context.Context, actor domain.User, raw json.RawMessage) error {
	if len(raw) == 0 || len(raw) > projectViewMaxBytes || !json.Valid(raw) {
		return domain.ErrInvalidInput
	}
	// "null" unmarshals into a nil map without error, so the shape check is
	// explicit: only a real object is a view.
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil || probe == nil {
		return domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	store, err := s.projectStore(tx)
	if err != nil {
		return err
	}
	if err = store.ProjectPutViewState(ctx, actor.ID, projectViewKey, raw); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func derefString(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}
