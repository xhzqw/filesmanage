package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"sort"
	"time"
)

// In-memory project store for unit tests. It mirrors the SQL adapter's
// semantics (live-only list ordered by update time, idempotent doc links,
// per-user view state) so service-level tests exercise real rules.

func (r *memoryRepo) projectsState() *memoryProjects {
	if r.projectData == nil {
		r.projectData = &memoryProjects{
			items:     map[int64]ports.Project{},
			comments:  map[int64][]ports.ProjectComment{},
			todos:     map[int64][]ports.ProjectTodo{},
			docs:      map[int64][]ports.ProjectDoc{},
			views:     map[string][]byte{},
			nextID:    1,
			nextSubID: 1,
		}
	}
	return r.projectData
}

func (r *memoryRepo) ProjectList(context.Context) ([]ports.Project, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.projectsState()
	out := make([]ports.Project, 0, len(state.items))
	for _, p := range state.items {
		if p.Archived {
			continue
		}
		out = append(out, r.projectWithChildren(state, p))
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].UpdatedAt.Equal(out[j].UpdatedAt) {
			return out[i].UpdatedAt.After(out[j].UpdatedAt)
		}
		return out[i].ID > out[j].ID
	})
	return out, nil
}

func (r *memoryRepo) projectWithChildren(state *memoryProjects, p ports.Project) ports.Project {
	p.Comments = append([]ports.ProjectComment{}, state.comments[p.ID]...)
	p.Todos = append([]ports.ProjectTodo{}, state.todos[p.ID]...)
	p.Docs = append([]ports.ProjectDoc{}, state.docs[p.ID]...)
	if p.Comments == nil {
		p.Comments = []ports.ProjectComment{}
	}
	if p.Todos == nil {
		p.Todos = []ports.ProjectTodo{}
	}
	if p.Docs == nil {
		p.Docs = []ports.ProjectDoc{}
	}
	if u, ok := r.users[p.OwnerID]; ok {
		p.OwnerName = u.user.DisplayName
	}
	return p
}

func (r *memoryRepo) ProjectByID(_ context.Context, id int64, _ bool) (ports.Project, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.projectsState()
	p, ok := state.items[id]
	if !ok {
		return ports.Project{}, domain.ErrNotFound
	}
	return r.projectWithChildren(state, p), nil
}

func (r *memoryRepo) ProjectCreate(_ context.Context, p ports.Project) (ports.Project, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.projectsState()
	p.ID = state.nextID
	state.nextID++
	now := time.Date(2026, 10, 8, 13, 0, 0, 0, time.UTC)
	p.CreatedAt, p.UpdatedAt = now, now
	state.items[p.ID] = p
	return r.projectWithChildren(state, p), nil
}

func (r *memoryRepo) ProjectUpdate(_ context.Context, p ports.Project) (ports.Project, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.projectsState()
	stored, ok := state.items[p.ID]
	if !ok {
		return ports.Project{}, domain.ErrNotFound
	}
	p.CreatedAt, p.CreatedBy = stored.CreatedAt, stored.CreatedBy
	p.UpdatedAt = stored.UpdatedAt.Add(time.Minute)
	state.items[p.ID] = p
	return r.projectWithChildren(state, p), nil
}

func (r *memoryRepo) ProjectSetArchived(_ context.Context, id int64, archived bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.projectsState()
	p, ok := state.items[id]
	if !ok {
		return domain.ErrNotFound
	}
	p.Archived = archived
	p.UpdatedAt = p.UpdatedAt.Add(time.Minute)
	state.items[id] = p
	return nil
}

func (r *memoryRepo) ProjectTouch(_ context.Context, id int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.projectsState()
	p, ok := state.items[id]
	if !ok {
		return domain.ErrNotFound
	}
	p.UpdatedAt = p.UpdatedAt.Add(time.Minute)
	state.items[id] = p
	return nil
}

func (r *memoryRepo) ProjectAddComment(_ context.Context, c ports.ProjectComment) (ports.ProjectComment, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.projectsState()
	c.ID = state.nextSubID
	state.nextSubID++
	c.CreatedAt = time.Date(2026, 10, 8, 13, 0, 0, 0, time.UTC)
	state.comments[c.ProjectID] = append(state.comments[c.ProjectID], c)
	return c, nil
}

func (r *memoryRepo) ProjectAddTodo(_ context.Context, t ports.ProjectTodo) (ports.ProjectTodo, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.projectsState()
	t.ID = state.nextSubID
	state.nextSubID++
	state.todos[t.ProjectID] = append(state.todos[t.ProjectID], t)
	return t, nil
}

func (r *memoryRepo) ProjectSetTodoDone(_ context.Context, id, todoID int64, done bool) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.projectsState()
	list := state.todos[id]
	for i := range list {
		if list[i].ID == todoID {
			list[i].Done = done
			state.todos[id] = list
			return true, nil
		}
	}
	return false, nil
}

func (r *memoryRepo) ProjectDeleteTodo(_ context.Context, id, todoID int64) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.projectsState()
	list := state.todos[id]
	for i := range list {
		if list[i].ID == todoID {
			state.todos[id] = append(list[:i:i], list[i+1:]...)
			return true, nil
		}
	}
	return false, nil
}

func (r *memoryRepo) ProjectUpsertDocs(_ context.Context, id int64, docs []ports.ProjectDoc) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.projectsState()
	if _, ok := state.items[id]; !ok {
		return 0, domain.ErrNotFound
	}
	existing := map[string]bool{}
	for _, d := range state.docs[id] {
		existing[d.DocID] = true
	}
	added := 0
	for _, doc := range docs {
		if existing[doc.DocID] {
			continue
		}
		existing[doc.DocID] = true
		state.docs[id] = append(state.docs[id], doc)
		added++
	}
	return added, nil
}

func (r *memoryRepo) ProjectDeleteDoc(_ context.Context, id int64, docID string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.projectsState()
	list := state.docs[id]
	for i := range list {
		if list[i].DocID == docID {
			state.docs[id] = append(list[:i:i], list[i+1:]...)
			return true, nil
		}
	}
	return false, nil
}

func (r *memoryRepo) ProjectViewState(_ context.Context, userID, key string) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.projectsState()
	raw, ok := state.views[userID+"\x00"+key]
	if !ok {
		return nil, domain.ErrNotFound
	}
	return append([]byte{}, raw...), nil
}

func (r *memoryRepo) ProjectPutViewState(_ context.Context, userID, key string, config []byte) error {
	if !json.Valid(config) {
		return domain.ErrInvalidInput
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.projectsState()
	state.views[userID+"\x00"+key] = append([]byte{}, config...)
	return nil
}

type memoryProjects struct {
	items     map[int64]ports.Project
	comments  map[int64][]ports.ProjectComment
	todos     map[int64][]ports.ProjectTodo
	docs      map[int64][]ports.ProjectDoc
	views     map[string][]byte
	nextID    int64
	nextSubID int64
}
