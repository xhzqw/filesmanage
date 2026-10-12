package application

import (
	"context"
	"filesmanage/internal/domain"
	"strings"
)

func (r *memoryRepo) ListDocumentAudit(_ context.Context, f domain.DocumentAuditFilter) ([]domain.PermissionAuditRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]domain.PermissionAuditRecord, 0, f.Limit)
	for i := len(r.audit) - 1; i >= 0 && len(out) < f.Limit; i-- {
		id := int64(i + 1)
		if f.BeforeID > 0 && id >= f.BeforeID {
			continue
		}
		e := r.audit[i]
		isDoc := e.TargetKind == "file" || e.TargetKind == "trash" || strings.HasPrefix(e.EventType, "office.") || strings.HasPrefix(e.EventType, "approval.")
		fileMatch := e.TargetKind == "file" && e.TargetID == f.FileID
		if e.TargetKind == "trash" {
			for _, entry := range r.trash {
				if entry.ID == e.TargetID && entry.FileID != nil && *entry.FileID == f.FileID {
					fileMatch = true
					break
				}
			}
		}
		if !isDoc || (f.FileID != "" && !fileMatch) ||
			(f.ActorID != "" && e.ActorID != f.ActorID) || (f.EventPrefix != "" && !strings.HasPrefix(e.EventType, f.EventPrefix)) {
			continue
		}
		out = append(out, domain.PermissionAuditRecord{
			ID: id, ActorID: e.ActorID, RequestID: e.RequestID, EventType: e.EventType,
			TargetKind: e.TargetKind, TargetID: e.TargetID, Outcome: e.Outcome, Details: e.Details,
		})
	}
	return out, nil
}
