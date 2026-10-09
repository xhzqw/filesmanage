package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"sort"
	"time"
)

// Organization methods for the in-memory test double: minimal but real
// behavior for the admin paths under test.

func (r *memoryRepo) ListUsers(_ context.Context) ([]domain.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	seen := map[string]bool{}
	out := make([]domain.User, 0)
	for _, entry := range r.users {
		if seen[entry.user.ID] {
			continue
		}
		seen[entry.user.ID] = true
		out = append(out, entry.user)
	}
	return out, nil
}

func (r *memoryRepo) PageUsers(ctx context.Context, afterID string, limit int) ([]domain.User, error) {
	users, err := r.ListUsers(ctx)
	if err != nil {
		return nil, err
	}
	sort.Slice(users, func(i, j int) bool { return users[i].ID < users[j].ID })
	out := make([]domain.User, 0)
	for _, u := range users {
		if u.ID > afterID && len(out) < limit {
			out = append(out, u)
		}
	}
	return out, nil
}

func (r *memoryRepo) UserByID(_ context.Context, id string) (domain.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.users[id]
	if !ok {
		return domain.User{}, ports.ErrRowMissing
	}
	return entry.user, nil
}

func (r *memoryRepo) CreateUser(_ context.Context, u domain.User, passwordHash string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.users[u.Login]; exists {
		return domain.ErrNameConflict
	}
	if _, exists := r.users[u.ID]; exists {
		return domain.ErrConflict
	}
	u.MustChangePassword = true
	r.users[u.ID] = memoryUser{user: u, hash: passwordHash}
	r.users[u.Login] = memoryUser{user: u, hash: passwordHash}
	return nil
}

func (r *memoryRepo) SetUserPassword(_ context.Context, userID, passwordHash string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.users[userID]
	if !ok {
		return ports.ErrRowMissing
	}
	entry.hash = passwordHash
	r.users[userID] = entry
	r.users[entry.user.Login] = entry
	for hash, session := range r.sessions {
		if session.userID == userID {
			delete(r.sessions, hash)
		}
	}
	return nil
}

func (r *memoryRepo) SetUserDepartment(_ context.Context, userID string, departmentID *string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.users[userID]
	if !ok {
		return ports.ErrRowMissing
	}
	if departmentID != nil {
		entry.user.DepartmentID = *departmentID
	} else {
		entry.user.DepartmentID = ""
	}
	r.users[userID] = entry
	r.users[entry.user.Login] = entry
	return nil
}

func (r *memoryRepo) SetUserDisabled(_ context.Context, userID string, disabled bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.users[userID]
	if !ok {
		return ports.ErrRowMissing
	}
	if disabled {
		now := time.Now()
		entry.user.DisabledAt = &now
	} else {
		entry.user.DisabledAt = nil
	}
	r.users[userID] = entry
	r.users[entry.user.Login] = entry
	if disabled {
		for hash, session := range r.sessions {
			if session.userID == userID {
				delete(r.sessions, hash)
			}
		}
	}
	return nil
}

func (r *memoryRepo) ForcePasswordChange(_ context.Context, userID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.users[userID]
	if !ok {
		return ports.ErrRowMissing
	}
	entry.user.MustChangePassword = true
	r.users[userID] = entry
	r.users[entry.user.Login] = entry
	return nil
}

func (r *memoryRepo) ListDepartments(context.Context) ([]domain.Department, error) {
	return []domain.Department{{ID: "dept_seed", Name: "种子部门"}}, nil
}

func (r *memoryRepo) CreateDepartment(_ context.Context, d domain.Department) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.departments = append(r.departments, d)
	return nil
}

func (r *memoryRepo) RenameDepartment(_ context.Context, id, name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, d := range r.departments {
		if d.ID == id {
			r.departments[i].Name = name
			return nil
		}
	}
	return ports.ErrRowMissing
}

func (r *memoryRepo) ListWorkgroups(_ context.Context) ([]domain.Workgroup, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]domain.Workgroup{}, r.workgroupList...), nil
}

func (r *memoryRepo) PageWorkgroups(ctx context.Context, afterID string, limit int) ([]domain.Workgroup, error) {
	groups, err := r.ListWorkgroups(ctx)
	if err != nil {
		return nil, err
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i].ID < groups[j].ID })
	out := make([]domain.Workgroup, 0)
	for _, g := range groups {
		if g.ID > afterID && len(out) < limit {
			out = append(out, g)
		}
	}
	return out, nil
}

func (r *memoryRepo) WorkgroupByID(_ context.Context, id string) (domain.Workgroup, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, g := range r.workgroupList {
		if g.ID == id {
			return g, nil
		}
	}
	return domain.Workgroup{}, ports.ErrRowMissing
}

func (r *memoryRepo) CreateWorkgroup(_ context.Context, g domain.Workgroup) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, existing := range r.workgroupList {
		if existing.ID == g.ID {
			return domain.ErrConflict
		}
	}
	r.workgroupList = append(r.workgroupList, g)
	return nil
}

func (r *memoryRepo) RenameWorkgroup(_ context.Context, id, name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, g := range r.workgroupList {
		if g.ID == id {
			r.workgroupList[i].Name = name
			return nil
		}
	}
	return ports.ErrRowMissing
}

func (r *memoryRepo) WorkgroupMembers(_ context.Context, groupID string) ([]domain.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.User, 0)
	seen := map[string]bool{}
	for _, id := range r.groupMembers[groupID] {
		if seen[id] {
			continue
		}
		seen[id] = true
		if entry, ok := r.users[id]; ok {
			out = append(out, entry.user)
		}
	}
	return out, nil
}

func (r *memoryRepo) AddWorkgroupMember(_ context.Context, groupID, userID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.users[userID]; !ok {
		return ports.ErrRowMissing
	}
	for _, id := range r.groupMembers[groupID] {
		if id == userID {
			return domain.ErrConflict
		}
	}
	r.groupMembers[groupID] = append(r.groupMembers[groupID], userID)
	r.workgroups[userID] = append(r.workgroups[userID], groupID)
	return nil
}

func (r *memoryRepo) RemoveWorkgroupMember(_ context.Context, groupID, userID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	members := r.groupMembers[groupID]
	for i, id := range members {
		if id == userID {
			r.groupMembers[groupID] = append(members[:i], members[i+1:]...)
			groups := r.workgroups[userID]
			for j, g := range groups {
				if g == groupID {
					r.workgroups[userID] = append(groups[:j], groups[j+1:]...)
					break
				}
			}
			return nil
		}
	}
	return ports.ErrRowMissing
}

var _ = errors.Is
