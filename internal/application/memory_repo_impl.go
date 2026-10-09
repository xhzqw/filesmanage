package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"sort"
	"strings"
	"time"
)

// memoryRepo implements every ports.Repository method. Methods exercised by the
// unit tests carry real behavior; the rest satisfy the contract with the
// simplest correct response.

func (r *memoryRepo) Ping(context.Context) error { return nil }

func (r *memoryRepo) UserByLogin(_ context.Context, login string) (domain.User, string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.users[login]
	if !ok || entry.user.DisabledAt != nil {
		return domain.User{}, "", ports.ErrRowMissing
	}
	return entry.user, entry.hash, nil
}

func (r *memoryRepo) UserBySessionHash(_ context.Context, hash string) (domain.Authenticated, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	session, ok := r.sessions[hash]
	if !ok || session.revoked {
		return domain.Authenticated{}, ports.ErrRowMissing
	}
	entry, ok := r.users[session.userID]
	if !ok || entry.user.DisabledAt != nil {
		return domain.Authenticated{}, ports.ErrRowMissing
	}
	return domain.Authenticated{User: entry.user, ExpiresAt: session.expires}, nil
}

func (r *memoryRepo) InsertSession(_ context.Context, hash, userID string, expiry time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sessions[hash] = memorySession{userID: userID, expires: expiry}
	return nil
}

func (r *memoryRepo) RevokeSession(_ context.Context, hash string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	session, ok := r.sessions[hash]
	if !ok {
		return ports.ErrRowMissing
	}
	session.revoked = true
	r.sessions[hash] = session
	return nil
}

func (r *memoryRepo) ChangePassword(_ context.Context, userID, oldHash, newHash, keepSessionHash string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.users[userID]
	if !ok || entry.hash != oldHash {
		return errors.New("precondition mismatch")
	}
	entry.hash = newHash
	entry.user.MustChangePassword = false
	r.users[userID] = entry
	delete(r.users, entry.user.Login)
	r.users[entry.user.Login] = entry
	for hash, session := range r.sessions {
		if session.userID == userID && hash != keepSessionHash {
			delete(r.sessions, hash)
		}
	}
	return nil
}

func (r *memoryRepo) ListVisibleFolders(_ context.Context, u domain.User) ([]domain.Folder, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.Folder, 0)
	for _, f := range r.folders {
		if f.DeletedAt != nil {
			continue
		}
		if u.IsAdmin || r.grantCoversLocked(u.ID, f.ID, domain.ActionList) {
			out = append(out, f)
		}
	}
	return out, nil
}

// folderKeyAfter reports whether the folder sorts after the (name,id) cursor
// key, using the same ascending name-then-id order the page query applies.
func folderKeyAfter(f domain.Folder, cursorName, cursorID string) bool {
	if f.Name != cursorName {
		return f.Name > cursorName
	}
	return f.ID > cursorID
}

// hasVisibleChildrenLocked mirrors the page query's EXISTS probe over the
// caller's visible children. Callers hold r.mu.
func (r *memoryRepo) hasVisibleChildrenLocked(u domain.User, folderID string) bool {
	for _, child := range r.folders {
		if child.DeletedAt != nil || child.ParentID == nil || *child.ParentID != folderID {
			continue
		}
		if u.IsAdmin || r.grantCoversLocked(u.ID, child.ID, domain.ActionList) {
			return true
		}
	}
	return false
}

// folderPageRowsLocked mirrors the SQL page read: visible folders passing filter,
// ordered by name then id, cut to the caller's lookahead limit. Callers hold r.mu.
func (r *memoryRepo) folderPageRowsLocked(u domain.User, filter func(domain.Folder) bool, cursorName, cursorID string, limit int) []ports.FolderPageRow {
	ordered := make([]domain.Folder, 0, len(r.folders))
	for _, f := range r.folders {
		if f.DeletedAt != nil {
			continue
		}
		if !u.IsAdmin && !r.grantCoversLocked(u.ID, f.ID, domain.ActionList) {
			continue
		}
		if !filter(f) {
			continue
		}
		if cursorID != "" && !folderKeyAfter(f, cursorName, cursorID) {
			continue
		}
		ordered = append(ordered, f)
	}
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].Name != ordered[j].Name {
			return ordered[i].Name < ordered[j].Name
		}
		return ordered[i].ID < ordered[j].ID
	})
	if limit > 0 && len(ordered) > limit {
		ordered = ordered[:limit]
	}
	rows := make([]ports.FolderPageRow, 0, len(ordered))
	for _, f := range ordered {
		rows = append(rows, ports.FolderPageRow{Folder: f, HasChildren: r.hasVisibleChildrenLocked(u, f.ID)})
	}
	return rows
}

func (r *memoryRepo) ListVisibleFolderChildren(_ context.Context, q ports.FolderChildQuery) ([]ports.FolderPageRow, error) {
	if q.Limit <= 0 || q.Limit > ports.MaxFolderPage+1 {
		return nil, domain.ErrInvalidInput
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.users[q.UserID]
	if !ok {
		return nil, ports.ErrRowMissing
	}
	u := entry.user
	filter := func(f domain.Folder) bool {
		if q.ParentID != "" {
			return f.ParentID != nil && *f.ParentID == q.ParentID
		}
		if f.ParentID == nil {
			return true
		}
		// A visible folder under a parent the caller cannot see is an accessible
		// root: the pruned subtree surfaces without its hidden ancestor.
		parent, exists := r.folders[*f.ParentID]
		if !exists || parent.DeletedAt != nil {
			return true
		}
		return !u.IsAdmin && !r.grantCoversLocked(u.ID, parent.ID, domain.ActionList)
	}
	return r.folderPageRowsLocked(u, filter, q.CursorName, q.CursorID, q.Limit), nil
}

func (r *memoryRepo) SearchVisibleFolders(_ context.Context, q ports.FolderSearchQuery) ([]ports.FolderPageRow, error) {
	if q.Limit <= 0 || q.Limit > ports.MaxFolderPage+1 {
		return nil, domain.ErrInvalidInput
	}
	if q.Query == "" {
		return nil, domain.ErrInvalidInput
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.users[q.UserID]
	if !ok {
		return nil, ports.ErrRowMissing
	}
	needle := lowerASCII(q.Query)
	filter := func(f domain.Folder) bool {
		return strings.Contains(lowerASCII(f.Name), needle)
	}
	return r.folderPageRowsLocked(entry.user, filter, q.CursorName, q.CursorID, q.Limit), nil
}

// grantCoversLocked approximates the SQL visibility rule: a live grant with the
// action on the folder itself or any ancestor.
func (r *memoryRepo) grantCoversLocked(userID, folderID string, action domain.Action) bool {
	current := folderID
	for depth := 0; depth <= 64 && current != ""; depth++ {
		folder, ok := r.folders[current]
		if !ok {
			return false
		}
		for _, g := range r.grants {
			if g.FolderID != current {
				continue
			}
			if g.ScopeOnly && depth > 0 {
				continue
			}
			if g.ExpiresAt != nil && !g.ExpiresAt.After(time.Now()) {
				continue
			}
			if g.SubjectKind == "user" && g.SubjectID == userID && hasAction(g.Actions, action) {
				return true
			}
			if g.SubjectKind == "group" && contains(r.workgroups[userID], g.SubjectID) && hasAction(g.Actions, action) {
				return true
			}
		}
		if folder.ParentID == nil {
			break
		}
		current = *folder.ParentID
	}
	return false
}

func hasAction(actions []domain.Action, want domain.Action) bool {
	for _, a := range actions {
		if a == want {
			return true
		}
	}
	return false
}

func contains(values []string, want string) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}

func (r *memoryRepo) FolderByID(_ context.Context, id string) (domain.Folder, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	f, ok := r.folders[id]
	if !ok {
		return domain.Folder{}, ports.ErrRowMissing
	}
	return f, nil
}

func (r *memoryRepo) FolderParentMap(_ context.Context) (map[string]*string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := map[string]*string{}
	for id, f := range r.folders {
		if f.DeletedAt == nil {
			out[id] = f.ParentID
		}
	}
	return out, nil
}

func (r *memoryRepo) CreateFolder(_ context.Context, f domain.Folder) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.folders[f.ID]; exists {
		return domain.ErrConflict
	}
	r.folders[f.ID] = f
	return nil
}

func (r *memoryRepo) RenameFolder(_ context.Context, id, name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	f, ok := r.folders[id]
	if !ok || f.DeletedAt != nil {
		return ports.ErrRowMissing
	}
	f.Name = name
	r.folders[id] = f
	return nil
}

func (r *memoryRepo) MoveFolder(_ context.Context, id string, parentID *string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	f, ok := r.folders[id]
	if !ok || f.DeletedAt != nil {
		return ports.ErrRowMissing
	}
	f.ParentID = parentID
	r.folders[id] = f
	return nil
}

func (r *memoryRepo) SoftDeleteFolder(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	f, ok := r.folders[id]
	if !ok || f.DeletedAt != nil {
		return ports.ErrRowMissing
	}
	now := time.Now()
	f.DeletedAt = &now
	r.folders[id] = f
	return nil
}

func (r *memoryRepo) RestoreFolder(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	f, ok := r.folders[id]
	if !ok || f.DeletedAt == nil {
		return ports.ErrRowMissing
	}
	f.DeletedAt = nil
	r.folders[id] = f
	return nil
}

func (r *memoryRepo) SoftDeleteFilesUnderFolders(_ context.Context, folderIDs []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	for id, f := range r.files {
		if contains(folderIDs, f.FolderID) && f.DeletedAt == nil {
			f.DeletedAt = &now
			r.files[id] = f
		}
	}
	return nil
}

func (r *memoryRepo) RestoreFilesUnderFolders(_ context.Context, folderIDs []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, f := range r.files {
		if contains(folderIDs, f.FolderID) && f.DeletedAt != nil {
			f.DeletedAt = nil
			r.files[id] = f
		}
	}
	return nil
}

func (r *memoryRepo) CountFilesInFolders(_ context.Context, folderIDs []string) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	count := 0
	for _, f := range r.files {
		if f.DeletedAt == nil && contains(folderIDs, f.FolderID) {
			count++
		}
	}
	return count, nil
}

func (r *memoryRepo) FolderSubtree(_ context.Context, id string) ([]domain.Folder, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	all := r.subtreeLocked(id, false)
	return all, nil
}

func (r *memoryRepo) FolderSubtreeIncludingDeleted(_ context.Context, id string) ([]domain.Folder, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.subtreeLocked(id, true), nil
}

func (r *memoryRepo) subtreeLocked(id string, includeDeleted bool) []domain.Folder {
	out := make([]domain.Folder, 0)
	root, ok := r.folders[id]
	if !ok {
		return out
	}
	if root.DeletedAt != nil && !includeDeleted {
		return out
	}
	out = append(out, root)
	var walk func(parent string, depth int)
	walk = func(parent string, depth int) {
		if depth > 64 {
			return
		}
		for _, f := range r.folders {
			if f.ParentID == nil || *f.ParentID != parent {
				continue
			}
			if f.DeletedAt != nil && !includeDeleted {
				continue
			}
			out = append(out, f)
			walk(f.ID, depth+1)
		}
	}
	walk(id, 0)
	return out
}

func (r *memoryRepo) SubtreeFileCount(_ context.Context, id string) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := map[string]bool{}
	for _, f := range r.subtreeLocked(id, false) {
		ids[f.ID] = true
	}
	count := 0
	for _, f := range r.files {
		if f.DeletedAt == nil && ids[f.FolderID] {
			count++
		}
	}
	return count, nil
}

func (r *memoryRepo) ListFiles(_ context.Context, q ports.FileQuery) ([]domain.File, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.File, 0)
	for _, f := range r.files {
		if f.FolderID != q.FolderID || f.DeletedAt != nil {
			continue
		}
		switch q.Sort {
		case "name_asc":
			if q.CursorID != "" && !(f.Name > q.CursorName || (f.Name == q.CursorName && f.ID > q.CursorID)) {
				continue
			}
		case "name_desc":
			if q.CursorID != "" && !(f.Name < q.CursorName || (f.Name == q.CursorName && f.ID < q.CursorID)) {
				continue
			}
		case "size_desc":
			if q.CursorID != "" && !(f.SizeBytes < q.CursorSize || (f.SizeBytes == q.CursorSize && f.ID < q.CursorID)) {
				continue
			}
		default:
			if q.CursorID != "" && !(f.UpdatedAt.Before(q.CursorTime) || (f.UpdatedAt.Equal(q.CursorTime) && f.ID < q.CursorID)) {
				continue
			}
		}
		out = append(out, f)
	}
	sortFiles(out, q.Sort)
	if q.Limit > 0 && len(out) > q.Limit {
		return out[:q.Limit], nil
	}
	return out, nil
}

func sortFiles(files []domain.File, sort string) {
	less := func(i, j int) bool {
		a, b := files[i], files[j]
		switch sort {
		case "name_asc":
			return a.Name < b.Name || (a.Name == b.Name && a.ID < b.ID)
		case "name_desc":
			return a.Name > b.Name || (a.Name == b.Name && a.ID > b.ID)
		case "size_desc":
			return a.SizeBytes > b.SizeBytes || (a.SizeBytes == b.SizeBytes && a.ID > b.ID)
		case "updated_asc":
			return a.UpdatedAt.Before(b.UpdatedAt) || (a.UpdatedAt.Equal(b.UpdatedAt) && a.ID < b.ID)
		default:
			return a.UpdatedAt.After(b.UpdatedAt) || (a.UpdatedAt.Equal(b.UpdatedAt) && a.ID > b.ID)
		}
	}
	for i := 1; i < len(files); i++ {
		for j := i; j > 0 && less(j, j-1); j-- {
			files[j], files[j-1] = files[j-1], files[j]
		}
	}
}

func (r *memoryRepo) FileByID(_ context.Context, id string) (domain.File, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	f, ok := r.files[id]
	if !ok {
		return domain.File{}, ports.ErrRowMissing
	}
	return f, nil
}

func (r *memoryRepo) FileByNameInFolder(_ context.Context, folderID, name string) (domain.File, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, f := range r.files {
		if f.FolderID == folderID && f.Name == name && f.DeletedAt == nil {
			return f, nil
		}
	}
	return domain.File{}, ports.ErrRowMissing
}

func (r *memoryRepo) RenameFile(_ context.Context, id, name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	f, ok := r.files[id]
	if !ok || f.DeletedAt != nil {
		return ports.ErrRowMissing
	}
	f.Name = name
	r.files[id] = f
	return nil
}

func (r *memoryRepo) MoveFile(_ context.Context, id, folderID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	f, ok := r.files[id]
	if !ok || f.DeletedAt != nil {
		return ports.ErrRowMissing
	}
	f.FolderID = folderID
	r.files[id] = f
	return nil
}

func (r *memoryRepo) CreateFileWithFirstVersion(_ context.Context, f domain.File, v domain.FileVersion) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, existing := range r.files {
		if existing.FolderID == f.FolderID && existing.Name == f.Name && existing.DeletedAt == nil {
			return domain.ErrNameConflict
		}
	}
	r.files[f.ID] = f
	r.versions[f.ID] = []domain.FileVersion{v}
	return nil
}

func (r *memoryRepo) InsertBlob(_ context.Context, b domain.Blob) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, existing := range r.blobs {
		if existing.Sha256 == b.Sha256 {
			return domain.ErrConflict
		}
	}
	r.blobs[b.ID] = b
	return nil
}

func (r *memoryRepo) HasActiveApprovalPolicy(context.Context, string) (bool, error) { return false, nil }

func (r *memoryRepo) AppendVersion(_ context.Context, v domain.FileVersion) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, existing := range r.versions[v.FileID] {
		if existing.Seq == v.Seq {
			return domain.ErrVersionConflict
		}
	}
	r.versions[v.FileID] = append(r.versions[v.FileID], v)
	return nil
}

func (r *memoryRepo) UpdateCurrentVersion(_ context.Context, fileID string, seq int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	f, ok := r.files[fileID]
	if !ok {
		return ports.ErrRowMissing
	}
	if f.CurrentVersionSeq != nil && *f.CurrentVersionSeq >= seq {
		return domain.ErrVersionConflict
	}
	f.CurrentVersionSeq = &seq
	f.UpdatedAt = time.Now()
	r.files[fileID] = f
	return nil
}

func (r *memoryRepo) SetFileContentType(_ context.Context, fileID, contentType string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	f, ok := r.files[fileID]
	if !ok {
		return ports.ErrRowMissing
	}
	f.ContentType = contentType
	r.files[fileID] = f
	return nil
}

func (r *memoryRepo) SoftDeleteFile(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	f, ok := r.files[id]
	if !ok || f.DeletedAt != nil {
		return ports.ErrRowMissing
	}
	now := time.Now()
	f.DeletedAt = &now
	r.files[id] = f
	return nil
}

func (r *memoryRepo) RestoreFile(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	f, ok := r.files[id]
	if !ok || f.DeletedAt == nil {
		return ports.ErrRowMissing
	}
	f.DeletedAt = nil
	r.files[id] = f
	return nil
}

func (r *memoryRepo) NextVersionSeq(_ context.Context, fileID string) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	max := 0
	for _, v := range r.versions[fileID] {
		if v.Seq > max {
			max = v.Seq
		}
	}
	return max + 1, nil
}

func (r *memoryRepo) VersionsByFile(_ context.Context, fileID string) ([]domain.FileVersion, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]domain.FileVersion{}, r.versions[fileID]...), nil
}

func (r *memoryRepo) VersionBySeq(_ context.Context, fileID string, seq int) (domain.FileVersion, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, v := range r.versions[fileID] {
		if v.Seq == seq {
			return v, nil
		}
	}
	return domain.FileVersion{}, ports.ErrRowMissing
}

func (r *memoryRepo) BlobBySha(_ context.Context, sha string) (domain.Blob, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, b := range r.blobs {
		if b.Sha256 == sha && b.State == "ready" {
			return b, nil
		}
	}
	return domain.Blob{}, ports.ErrRowMissing
}

func (r *memoryRepo) BlobByID(_ context.Context, id string) (domain.Blob, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, ok := r.blobs[id]
	if !ok {
		return domain.Blob{}, ports.ErrRowMissing
	}
	return b, nil
}

func (r *memoryRepo) SetBlobState(_ context.Context, id, state string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, ok := r.blobs[id]
	if !ok {
		return ports.ErrRowMissing
	}
	b.State = state
	r.blobs[id] = b
	return nil
}

func (r *memoryRepo) WorkgroupsOf(_ context.Context, userID string) ([]string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string{}, r.workgroups[userID]...), nil
}

func (r *memoryRepo) EffectiveGrants(_ context.Context, userID, folderID string) ([]ports.GrantAt, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	groups := r.workgroups[userID]
	out := make([]ports.GrantAt, 0)
	current := folderID
	for depth := 0; depth <= 64 && current != ""; depth++ {
		folder, ok := r.folders[current]
		if !ok {
			break
		}
		for _, g := range r.grants {
			if g.FolderID != current {
				continue
			}
			applies := (g.SubjectKind == "user" && g.SubjectID == userID) ||
				(g.SubjectKind == "group" && contains(groups, g.SubjectID))
			if !applies {
				continue
			}
			if g.ExpiresAt != nil && !g.ExpiresAt.After(time.Now()) {
				continue
			}
			out = append(out, ports.GrantAt{Grant: g, Depth: depth})
		}
		if folder.ParentID == nil {
			break
		}
		current = *folder.ParentID
	}
	return out, nil
}

func (r *memoryRepo) ListGrants(_ context.Context, folderID string) ([]domain.ACL, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.ACL, 0)
	for _, g := range r.grants {
		if g.FolderID == folderID {
			out = append(out, g)
		}
	}
	return out, nil
}

func (r *memoryRepo) GrantByID(_ context.Context, id string) (domain.ACL, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	g, ok := r.grants[id]
	if !ok {
		return domain.ACL{}, ports.ErrRowMissing
	}
	return g, nil
}

func (r *memoryRepo) InsertGrant(_ context.Context, g domain.ACL) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(g.Actions) == 0 || (g.SubjectKind != "user" && g.SubjectKind != "group") {
		return domain.ErrInvalidInput
	}
	for _, a := range g.Actions {
		if !domain.AllowedAction(a) {
			return domain.ErrInvalidInput
		}
	}
	r.grants[g.ID] = g
	return nil
}

func (r *memoryRepo) DeleteGrant(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.grants[id]; !ok {
		return ports.ErrRowMissing
	}
	delete(r.grants, id)
	return nil
}

func (r *memoryRepo) UserExists(_ context.Context, id string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.users[id]
	return ok && entry.user.DisabledAt == nil, nil
}

func (r *memoryRepo) WorkgroupExists(_ context.Context, id string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, g := range r.workgroupList {
		if g.ID == id {
			return true, nil
		}
	}
	for _, groups := range r.workgroups {
		if contains(groups, id) {
			return true, nil
		}
	}
	return false, nil
}

func (r *memoryRepo) InsertTrashEntry(_ context.Context, t domain.TrashEntry) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.trash = append(r.trash, t)
	return nil
}

func (r *memoryRepo) ListTrashEntries(_ context.Context, userID string) ([]domain.TrashEntry, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.TrashEntry, 0)
	for _, t := range r.trash {
		if t.RestoredAt != nil || t.PurgedAt != nil {
			continue
		}
		if t.DeletedBy == userID {
			out = append(out, t)
		}
	}
	return out, nil
}

func (r *memoryRepo) TrashEntryByID(_ context.Context, id string) (domain.TrashEntry, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, t := range r.trash {
		if t.ID == id {
			return t, nil
		}
	}
	return domain.TrashEntry{}, ports.ErrRowMissing
}

func (r *memoryRepo) MarkTrashRestored(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, t := range r.trash {
		if t.ID == id {
			if t.RestoredAt != nil || t.PurgedAt != nil {
				return ports.ErrRowMissing
			}
			now := time.Now()
			r.trash[i].RestoredAt = &now
			return nil
		}
	}
	return ports.ErrRowMissing
}

func (r *memoryRepo) MarkTrashPurged(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, t := range r.trash {
		if t.ID == id {
			if t.PurgedAt != nil {
				return ports.ErrRowMissing
			}
			now := time.Now()
			r.trash[i].PurgedAt = &now
			return nil
		}
	}
	return ports.ErrRowMissing
}

func (r *memoryRepo) LockFileRow(_ context.Context, fileID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.files[fileID]; !ok {
		return ports.ErrRowMissing
	}
	return nil
}

func (r *memoryRepo) RecordAudit(_ context.Context, e domain.AuditEvent) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.audit = append(r.audit, e)
	return nil
}

func (r *memoryRepo) ListPermissionAudit(_ context.Context, beforeID int64, limit int) ([]domain.PermissionAuditRecord, error) {
	if beforeID < 0 || limit < 1 || limit > 101 {
		return nil, domain.ErrInvalidInput
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.PermissionAuditRecord, 0, limit)
	for i := len(r.audit) - 1; i >= 0 && len(out) < limit; i-- {
		id := int64(i + 1)
		if beforeID > 0 && id >= beforeID {
			continue
		}
		e := r.audit[i]
		switch e.EventType {
		case "acl.create", "acl.revoke", "workgroup.member_add", "workgroup.member_remove",
			"user.create", "user.disable", "user.enable", "user.password_reset",
			"share.create", "share.revoke":
			out = append(out, domain.PermissionAuditRecord{
				ID: id, ActorID: e.ActorID, EventType: e.EventType,
				TargetKind: e.TargetKind, TargetID: e.TargetID,
				Outcome: e.Outcome, Details: e.Details,
			})
		}
	}
	return out, nil
}

func (r *memoryRepo) IdempotencyGet(_ context.Context, actor, operation, key string) ([]byte, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if key == "" {
		return nil, false, nil
	}
	response, ok := r.idempotency[actor+"|"+operation+"|"+key]
	if !ok {
		return nil, false, nil
	}
	return response, true, nil
}

func (r *memoryRepo) IdempotencyPut(_ context.Context, actor, operation, key string, response []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if key == "" {
		return nil
	}
	r.idempotency[actor+"|"+operation+"|"+key] = response
	return nil
}
