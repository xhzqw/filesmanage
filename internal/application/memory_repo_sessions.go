package application

import (
	"context"
	"filesmanage/internal/ports"
	"strings"
	"time"
)

func (r *memoryRepo) SetSessionMetadata(_ context.Context, hash, address, device string) error {
	// Tests persist session ownership in memory. Device metadata is not used
	// for authorization; production stores it in the database.
	return nil
}
func (r *memoryRepo) TouchSession(context.Context, string) error { return nil }
func (r *memoryRepo) SessionOwner(_ context.Context, hash string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.sessions[hash]
	if !ok || v.revoked {
		return "", ports.ErrRowMissing
	}
	return v.userID, nil
}
func (r *memoryRepo) ListOwnSessions(_ context.Context, userID string) ([]ports.SessionRow, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rows := make([]ports.SessionRow, 0, 4)
	for hash, v := range r.sessions {
		if v.userID != userID || v.revoked || len(hash) < 24 {
			continue
		}
		created := v.expires.Add(-24 * time.Hour)
		rows = append(rows, ports.SessionRow{ID: hash[:24], Device: "测试客户端", CreatedAt: created, LastSeenAt: created, ExpiresAt: v.expires})
	}
	return rows, nil
}
func (r *memoryRepo) RevokeOwnSession(_ context.Context, userID, id, currentHash string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(id) != 24 || strings.Trim(id, "0123456789abcdef") != "" {
		return false, nil
	}
	for hash, v := range r.sessions {
		if v.userID == userID && !v.revoked && hash != currentHash && strings.HasPrefix(hash, id) {
			v.revoked = true
			r.sessions[hash] = v
			return true, nil
		}
	}
	return false, nil
}
func (r *memoryRepo) RevokeOtherSessions(_ context.Context, userID, currentHash string) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var count int64
	for hash, v := range r.sessions {
		if v.userID == userID && !v.revoked && hash != currentHash {
			v.revoked = true
			r.sessions[hash] = v
			count++
		}
	}
	return count, nil
}
func (r *memoryRepo) ListOwnAuthActivity(_ context.Context, userID string) ([]ports.AuthActivity, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rows := make([]ports.AuthActivity, 0, 8)
	for i := len(r.audit) - 1; i >= 0 && len(rows) < 30; i-- {
		event := r.audit[i]
		if event.ActorID != userID || !strings.HasPrefix(event.EventType, "auth.") {
			continue
		}
		item := ports.AuthActivity{Type: event.EventType, OccurredAt: time.Now()}
		if v, ok := event.Details["device"].(string); ok {
			item.Device = v
		}
		if v, ok := event.Details["ip"].(string); ok {
			item.Address = v
		}
		if v, ok := event.Details["count"].(int64); ok {
			item.Count = int(v)
		}
		rows = append(rows, item)
	}
	return rows, nil
}
