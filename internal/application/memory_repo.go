package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"sync"
	"time"
)

// memoryRepo is an in-memory ports.Repository for unit tests. Only the paths
// under test carry behavior; untouched methods return zero values.
type memoryRepo struct {
	mu           sync.Mutex
	users        map[string]memoryUser
	sessions     map[string]memorySession
	folders      map[string]domain.Folder
	files        map[string]domain.File
	versions     map[string][]domain.FileVersion
	blobs        map[string]domain.Blob
	grants       map[string]domain.ACL
	trash        []domain.TrashEntry
	workgroups   map[string][]string
	audit        []domain.AuditEvent
	idempotency  map[string][]byte
	failOnCommit bool
}

type memoryUser struct {
	user domain.User
	hash string
}

type memorySession struct {
	userID  string
	expires time.Time
	revoked bool
}

func newMemoryRepo() *memoryRepo {
	return &memoryRepo{
		users:       map[string]memoryUser{},
		sessions:    map[string]memorySession{},
		folders:     map[string]domain.Folder{},
		files:       map[string]domain.File{},
		versions:    map[string][]domain.FileVersion{},
		blobs:       map[string]domain.Blob{},
		grants:      map[string]domain.ACL{},
		workgroups:  map[string][]string{},
		idempotency: map[string][]byte{},
	}
}

func (r *memoryRepo) seedUser(u domain.User, hash string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.users[u.ID] = memoryUser{user: u, hash: hash}
	r.users[u.Login] = memoryUser{user: u, hash: hash}
}

func (r *memoryRepo) seedFolder(f domain.Folder) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.folders[f.ID] = f
}

func (r *memoryRepo) seedGrant(g domain.ACL) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.grants[g.ID] = g
}

// Begin returns a tx that mutates the same maps; commit is a no-op unless the
// test asks it to fail.
func (r *memoryRepo) Begin(ctx context.Context) (ports.Tx, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.failOnCommit {
		return nil, errors.New("begin failed by test")
	}
	return memoryTx{r}, nil
}

type memoryTx struct{ *memoryRepo }

func (t memoryTx) Commit(context.Context) error {
	if t.memoryRepo.failOnCommit {
		return errors.New("commit failed by test")
	}
	return nil
}
func (t memoryTx) Rollback(context.Context) error { return nil }

func (r *memoryRepo) memoryRepo() *memoryRepo { return r }

func sha256Sum(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
