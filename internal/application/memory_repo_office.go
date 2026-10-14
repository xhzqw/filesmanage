package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"time"
)

// In-memory office stores for unit tests.

func (r *memoryRepo) CreateOfficeSession(_ context.Context, s domain.OfficeSession) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, existing := range r.officeSessions {
		if existing.DocumentKey == s.DocumentKey {
			return domain.ErrConflict
		}
	}
	r.officeSessions = append(r.officeSessions, s)
	return nil
}

func (r *memoryRepo) OfficeSessionByID(_ context.Context, id string) (domain.OfficeSession, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.officeSessions {
		if s.ID == id {
			return s, nil
		}
	}
	return domain.OfficeSession{}, ports.ErrRowMissing
}

func (r *memoryRepo) OfficeSessionByKey(_ context.Context, key string) (domain.OfficeSession, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.officeSessions {
		if s.DocumentKey == key {
			return s, nil
		}
	}
	return domain.OfficeSession{}, ports.ErrRowMissing
}

func (r *memoryRepo) LockOfficeSessionByKey(ctx context.Context, key string) error {
	_, err := r.OfficeSessionByKey(ctx, key)
	return err
}

func (r *memoryRepo) ActiveOfficeSessionForFile(_ context.Context, fileID string) (domain.OfficeSession, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.officeSessions {
		if s.FileID == fileID && (s.State == domain.OfficeStateOpen || s.State == domain.OfficeStateSaving) && s.ClosedAt == nil {
			return s, true, nil
		}
	}
	return domain.OfficeSession{}, false, nil
}

func (r *memoryRepo) SetOfficeSessionState(_ context.Context, id, state string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.officeSessions {
		if r.officeSessions[i].ID == id {
			r.officeSessions[i].State = state
			return nil
		}
	}
	return ports.ErrRowMissing
}

func (r *memoryRepo) SetOfficeSessionBaseSeq(_ context.Context, id string, seq int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.officeSessions {
		if r.officeSessions[i].ID == id {
			r.officeSessions[i].BaseSeq = seq
			return nil
		}
	}
	return ports.ErrRowMissing
}

func (r *memoryRepo) BumpOfficeSessionGeneration(_ context.Context, id string) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.officeSessions {
		if r.officeSessions[i].ID == id {
			r.officeSessions[i].LockGeneration++
			return r.officeSessions[i].LockGeneration, nil
		}
	}
	return 0, ports.ErrRowMissing
}

func (r *memoryRepo) TouchOfficeSession(_ context.Context, id string, expires time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.officeSessions {
		if r.officeSessions[i].ID == id {
			r.officeSessions[i].ExpiresAt = expires
			return nil
		}
	}
	return ports.ErrRowMissing
}

func (r *memoryRepo) CloseOfficeSession(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.officeSessions {
		if r.officeSessions[i].ID == id && (r.officeSessions[i].State == domain.OfficeStateOpen ||
			r.officeSessions[i].State == domain.OfficeStateSaving || r.officeSessions[i].State == domain.OfficeStatePending) {
			r.officeSessions[i].State = domain.OfficeStateAbandoned
			now := time.Now()
			r.officeSessions[i].ClosedAt = &now
			return nil
		}
	}
	return ports.ErrRowMissing
}

func (r *memoryRepo) SaveEventExists(_ context.Context, sessionID, eventHash string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range r.saveEvents {
		if e.SessionID == sessionID && e.EventHash == eventHash {
			return true, nil
		}
	}
	return false, nil
}

func (r *memoryRepo) OfficeSaveEventOutcome(_ context.Context, sessionID, eventHash string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range r.saveEvents {
		if e.SessionID == sessionID && e.EventHash == eventHash {
			return e.Outcome, nil
		}
	}
	return "", nil
}

func (r *memoryRepo) OfficeNativeSaveCounts(_ context.Context, sessionID string) (int64, int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var committed, failed int64
	for _, event := range r.saveEvents {
		if event.SessionID != sessionID {
			continue
		}
		switch event.Outcome {
		case "native_committed":
			committed++
		case "native_failed":
			failed++
		}
	}
	return committed, failed, nil
}

func (r *memoryRepo) RecordSaveEvent(_ context.Context, e domain.OfficeSaveEvent) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, existing := range r.saveEvents {
		if existing.SessionID == e.SessionID && existing.EventHash == e.EventHash {
			return domain.ErrConflict
		}
	}
	r.saveEvents = append(r.saveEvents, e)
	return nil
}

func (r *memoryRepo) RecordCompatibilityReport(_ context.Context, rep domain.OfficeCompatibilityReport) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.compatReports = append(r.compatReports, rep)
	return nil
}

var _ = errors.Is
