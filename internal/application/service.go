package application

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"fmt"
	"golang.org/x/crypto/bcrypt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	ErrUnauthorized       = errors.New("authentication required")
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrInvalidInput       = errors.New("invalid input")
	ErrPasswordPolicy     = errors.New("password must be at least 16 characters")
)

// Service orchestrates use cases. Every write runs inside one transaction
// obtained from the unit of work; blob bytes are staged outside transactions
// and only referenced inside them.
type Service struct {
	uow     ports.UnitOfWork
	blobs   ports.BlobStore
	office  OfficeConfig
	now     func() time.Time
	stats   statsCache
	search  searchCache
	session sessionCache
	// aclEpoch changes whenever an authorisation decision could change: grants,
	// shares, user disabling, folder moves and trash restores all bump it, and
	// every cached read key includes it. That is what makes "the next request
	// after a revocation loses access" (PE04) hold despite the caches - a
	// revocation invalidates every cached page at once instead of waiting for
	// the TTL to expire.
	aclEpoch atomic.Uint64
}

// statsCache memoises dashboard aggregations for a short TTL. The key carries
// the caller's identity and the full filter, so a cached entry is only ever
// served to the same principal with the same scope - an ACL change cannot leak
// through the cache. The TTL bounds staleness after a write; a dashboard is
// allowed to lag by that much, and the win is that N viewers of the same scope
// cost one aggregation instead of N (PE06/PE07 headroom on large datasets).
type statsCache struct {
	mu      sync.Mutex
	entries map[string]statsEntry
	ttl     time.Duration
}

// maxCacheEntries bounds every in-process cache: keys are principal+filter
// combinations, so a long-running server with many users and varied filters
// would otherwise grow the map without limit. Expired entries are evicted
// whenever the cap is exceeded; if the map is still full afterwards the new
// entry is simply not cached (a cache miss costs a query, never correctness).
const maxCacheEntries = 4096

// pruneLocked drops expired entries. Callers hold c.mu.
func pruneLocked[E any](entries map[string]E, expireAt func(E) time.Time, now time.Time) int {
	removed := 0
	for key, entry := range entries {
		if !expireAt(entry).After(now) {
			delete(entries, key)
			removed++
		}
	}
	return removed
}

type statsEntry struct {
	value    domain.Stats
	expireAt time.Time
}

// sessionCache memoises session validation for a few seconds. Every
// authenticated request would otherwise spend a database round-trip on the
// session lookup; under load that round-trip is what queues cheap endpoints
// behind the pool. Revocation is immediate despite the cache: Logout,
// ChangePassword and SetUserDisabled drop the entry (and the user's entries)
// explicitly, so "logout invalidates the session at once" still holds.
type sessionCache struct {
	mu      sync.Mutex
	entries map[string]sessionEntry
	ttl     time.Duration
}

type sessionEntry struct {
	value    domain.Authenticated
	expireAt time.Time
	epoch    uint64
}

func (c *sessionCache) get(token string, now time.Time, epoch uint64) (domain.Authenticated, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[token]
	if !ok || !entry.expireAt.After(now) || !entry.value.ExpiresAt.After(now) || entry.epoch != epoch {
		return domain.Authenticated{}, false
	}
	return entry.value, true
}

func (c *sessionCache) put(token string, value domain.Authenticated, now time.Time, epoch uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]sessionEntry)
	}
	if len(c.entries) >= maxCacheEntries {
		pruneLocked(c.entries, func(e sessionEntry) time.Time { return e.expireAt }, now)
		if len(c.entries) >= maxCacheEntries {
			return
		}
	}
	expires := now.Add(c.ttl)
	if value.ExpiresAt.Before(expires) {
		expires = value.ExpiresAt
	}
	if expires.After(now) {
		c.entries[token] = sessionEntry{value: value, expireAt: expires, epoch: epoch}
	}
}

func (c *sessionCache) drop(token string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, token)
}

// dropUser removes every cached session belonging to a user, so disabling an
// account takes effect on the next request rather than after the TTL.
func (c *sessionCache) dropUser(userID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for token, entry := range c.entries {
		if entry.value.User.ID == userID {
			delete(c.entries, token)
		}
	}
}

// searchCache memoises search pages for a shorter TTL than the dashboard
// aggregates: a freshly uploaded file must not be missing from results for
// long, so the staleness window is deliberately tighter.
type searchCache struct {
	mu      sync.Mutex
	entries map[string]searchEntry
	ttl     time.Duration
}

type searchEntry struct {
	value    searchEntryValue
	expireAt time.Time
}

type searchEntryValue struct {
	files      []domain.File
	total      int
	nextCursor string
}

func (c *searchCache) get(key string, now time.Time) (searchEntryValue, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if !ok || !entry.expireAt.After(now) {
		return searchEntryValue{}, false
	}
	return entry.value, true
}

func (c *searchCache) put(key string, value searchEntryValue, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]searchEntry)
	}
	if len(c.entries) >= maxCacheEntries {
		pruneLocked(c.entries, func(e searchEntry) time.Time { return e.expireAt }, now)
		if len(c.entries) >= maxCacheEntries {
			return
		}
	}
	c.entries[key] = searchEntry{value: value, expireAt: now.Add(c.ttl)}
}

func (c *statsCache) get(key string, now time.Time) (domain.Stats, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if !ok || !entry.expireAt.After(now) {
		return domain.Stats{}, false
	}
	return entry.value, true
}

func (c *statsCache) put(key string, value domain.Stats, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]statsEntry)
	}
	if len(c.entries) >= maxCacheEntries {
		pruneLocked(c.entries, func(e statsEntry) time.Time { return e.expireAt }, now)
		if len(c.entries) >= maxCacheEntries {
			return
		}
	}
	c.entries[key] = statsEntry{value: value, expireAt: now.Add(c.ttl)}
}

func New(uow ports.UnitOfWork, blobs ports.BlobStore) *Service {
	service := &Service{
		uow: uow, blobs: blobs, now: time.Now,
		stats:   statsCache{ttl: 30 * time.Second},
		search:  searchCache{ttl: 10 * time.Second},
		session: sessionCache{ttl: 5 * time.Second},
	}
	service.aclEpoch.Store(1)
	return service
}

// bumpACLEpoch invalidates every cached read atomically. Called after any
// authorisation-relevant mutation commits.
func (s *Service) bumpACLEpoch() { s.aclEpoch.Add(1) }

// epoch returns the current authorisation epoch for cache keys.
func (s *Service) epoch() uint64 { return s.aclEpoch.Load() }

// WithOffice wires the external document editor endpoints.
func (s *Service) WithOffice(config OfficeConfig) *Service { s.office = config; return s }

func (s *Service) WithClock(f func() time.Time) *Service { s.now = f; return s }

func HashToken(token string) string {
	d := sha256.Sum256([]byte(token))
	return hex.EncodeToString(d[:])
}

func mustMarshal(v any) []byte {
	raw, err := json.Marshal(v)
	if err != nil {
		return []byte("null")
	}
	return raw
}

func newRequestID() string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "req-unknown"
	}
	return "req-" + hex.EncodeToString(raw)
}

// NewID returns an opaque, collision-resistant identifier with a readable prefix.
func NewID(prefix string) string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return prefix + "_" + hex.EncodeToString(raw)
}

func newSessionToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func (s *Service) Ready(ctx context.Context) error {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	return tx.Ping(ctx)
}

// ---------- authentication ----------

func (s *Service) Login(ctx context.Context, login, password string) (string, domain.User, error) {
	login = strings.TrimSpace(login)
	if len(login) < 1 || len(login) > 80 || len(password) == 0 || len(password) > 1024 {
		return "", domain.User{}, ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return "", domain.User{}, err
	}
	defer tx.Rollback(ctx)
	u, hash, err := tx.UserByLogin(ctx, login)
	if err != nil {
		if errors.Is(err, ports.ErrRowMissing) {
			return "", domain.User{}, ErrInvalidCredentials
		}
		return "", domain.User{}, err
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return "", domain.User{}, ErrInvalidCredentials
	}
	token, err := newSessionToken()
	if err != nil {
		return "", domain.User{}, err
	}
	if err = tx.InsertSession(ctx, HashToken(token), u.ID, s.now().Add(24*time.Hour)); err != nil {
		return "", domain.User{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", domain.User{}, err
	}
	return token, u, nil
}

func (s *Service) Session(ctx context.Context, token string) (domain.Authenticated, error) {
	if len(token) != 43 {
		return domain.Authenticated{}, ErrUnauthorized
	}
	// The epoch is sampled BEFORE any DB read. If a revocation commits while
	// the read is in flight, a later cache insertion remains tagged with the
	// old epoch and cannot survive into the next request.
	epoch := s.epoch()
	if cached, ok := s.session.get(token, s.now(), epoch); ok {
		return cached, nil
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.Authenticated{}, err
	}
	defer tx.Rollback(ctx)
	a, err := tx.UserBySessionHash(ctx, HashToken(token))
	if err != nil {
		if errors.Is(err, ports.ErrRowMissing) {
			return domain.Authenticated{}, ErrUnauthorized
		}
		return domain.Authenticated{}, err
	}
	if !a.ExpiresAt.After(s.now()) {
		return domain.Authenticated{}, ErrUnauthorized
	}
	s.session.put(token, a, s.now(), epoch)
	return a, nil
}

func (s *Service) Logout(ctx context.Context, token string) error {
	if len(token) != 43 {
		return ErrUnauthorized
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = tx.RevokeSession(ctx, HashToken(token)); err != nil {
		if errors.Is(err, ports.ErrRowMissing) {
			s.session.drop(token)
			return ErrUnauthorized
		}
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.bumpACLEpoch()
	s.session.drop(token)
	return nil
}

func (s *Service) ChangePassword(ctx context.Context, sessionToken, oldPassword, newPassword string) (domain.User, error) {
	a, err := s.Session(ctx, sessionToken)
	if err != nil {
		return domain.User{}, ErrUnauthorized
	}
	if len(newPassword) < 16 || len(newPassword) > 128 {
		return domain.User{}, ErrPasswordPolicy
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.User{}, err
	}
	defer tx.Rollback(ctx)
	u, previousHash, err := tx.UserByLogin(ctx, a.User.Login)
	if err != nil || u.ID != a.User.ID {
		return domain.User{}, ErrUnauthorized
	}
	if bcrypt.CompareHashAndPassword([]byte(previousHash), []byte(oldPassword)) != nil {
		return domain.User{}, ErrInvalidCredentials
	}
	if bcrypt.CompareHashAndPassword([]byte(previousHash), []byte(newPassword)) == nil {
		return domain.User{}, ErrPasswordPolicy
	}
	newHash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return domain.User{}, err
	}
	if err = tx.ChangePassword(ctx, u.ID, previousHash, string(newHash), HashToken(sessionToken)); err != nil {
		return domain.User{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.User{}, err
	}
	// The repository revokes the user other sessions with the password change;
	// drop the cached copies so that revocation is visible at once. The acting
	// session is re-cached on its next request.
	s.bumpACLEpoch()
	s.session.dropUser(u.ID)
	u.MustChangePassword = false
	return u, nil
}

func (s *Service) Folders(ctx context.Context, u domain.User) ([]domain.Folder, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	return tx.ListVisibleFolders(ctx, u)
}

// ---------- shared helpers ----------

func allActions() map[domain.Action]bool {
	return map[domain.Action]bool{
		domain.ActionList: true, domain.ActionPreview: true, domain.ActionUpload: true,
		domain.ActionDownload: true, domain.ActionModify: true, domain.ActionDelete: true,
		domain.ActionRename: true, domain.ActionMove: true, domain.ActionPrint: true,
	}
}

// audit records a best-effort event inside the caller's transaction.
func audit(ctx context.Context, repo ports.Repository, actor domain.User, eventType, targetKind, targetID, outcome string, details map[string]any) {
	_ = auditRequired(ctx, repo, actor, eventType, targetKind, targetID, outcome, details)
}

// Audit correlation IDs come only from server-generated request context.
// Do not accept client-supplied request IDs into this security ledger.
type auditRequestIDKey struct{}

func NewAuditRequestID() string { return newRequestID() }

func WithAuditRequestID(ctx context.Context, requestID string) context.Context {
	return context.WithValue(ctx, auditRequestIDKey{}, requestID)
}

func auditRequestID(ctx context.Context) string {
	if requestID, ok := ctx.Value(auditRequestIDKey{}).(string); ok && requestID != "" {
		return requestID
	}
	return newRequestID()
}

// auditRequired must be checked before committing an access-changing
// transaction. Failed audit storage therefore fails closed for writes.
func auditRequired(ctx context.Context, repo ports.Repository, actor domain.User, eventType, targetKind, targetID, outcome string, details map[string]any) error {
	return repo.RecordAudit(ctx, domain.AuditEvent{
		ActorID:    actor.ID,
		EventType:  eventType,
		TargetKind: targetKind,
		TargetID:   targetID,
		RequestID:  auditRequestID(ctx),
		Outcome:    outcome,
		Details:    details,
	})
}

// idempotentResult replays a stored response for a repeated request key.
func idempotentResult(ctx context.Context, repo ports.Repository, actorID, operation, key string) ([]byte, bool, error) {
	if key == "" {
		return nil, false, nil
	}
	return repo.IdempotencyGet(ctx, actorID, operation, key)
}

func storeIdempotentResult(ctx context.Context, repo ports.Repository, actorID, operation, key string, response []byte) {
	if key == "" {
		return
	}
	_ = repo.IdempotencyPut(ctx, actorID, operation, key, response)
}

// mapError converts domain errors into transport-friendly sentinels.
func mapError(err error) error {
	switch {
	case errors.Is(err, domain.ErrNotFound), errors.Is(err, ports.ErrRowMissing):
		return domain.ErrNotFound
	case errors.Is(err, domain.ErrForbidden):
		return domain.ErrForbidden
	case errors.Is(err, domain.ErrNameConflict):
		return domain.ErrNameConflict
	case errors.Is(err, domain.ErrVersionConflict):
		return domain.ErrVersionConflict
	case errors.Is(err, domain.ErrLocked):
		return domain.ErrLocked
	case errors.Is(err, domain.ErrApprovalPending):
		return domain.ErrApprovalPending
	case errors.Is(err, domain.ErrParentMissing):
		return domain.ErrParentMissing
	case errors.Is(err, domain.ErrInvalidInput):
		return domain.ErrInvalidInput
	default:
		return err
	}
}

var _ = fmt.Sprint
var _ io.Reader
