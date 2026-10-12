package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
	"time"
)

// ---------- document editor sessions ----------

const officeSessionSelect = "SELECT id,file_id,owner_id,base_seq,document_key,state,lock_generation,expires_at,created_at,closed_at FROM office_sessions"

func scanOfficeSession(row rowScanner) (domain.OfficeSession, error) {
	var s domain.OfficeSession
	err := row.Scan(&s.ID, &s.FileID, &s.OwnerID, &s.BaseSeq, &s.DocumentKey, &s.State,
		&s.LockGeneration, &s.ExpiresAt, &s.CreatedAt, &s.ClosedAt)
	return s, err
}

func (r *Repository) CreateOfficeSession(ctx context.Context, s domain.OfficeSession) error {
	_, err := r.Q.Exec(ctx,
		`INSERT INTO office_sessions(id,file_id,owner_id,base_seq,document_key,state,lock_generation,expires_at)
		 VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		s.ID, s.FileID, s.OwnerID, s.BaseSeq, s.DocumentKey, s.State, s.LockGeneration, s.ExpiresAt)
	if isUniqueViolation(err) {
		return domain.ErrConflict
	}
	return err
}

func (r *Repository) OfficeSessionByID(ctx context.Context, id string) (domain.OfficeSession, error) {
	row := r.Q.QueryRow(ctx, officeSessionSelect+" WHERE id=$1", id)
	s, err := scanOfficeSession(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.OfficeSession{}, ports.ErrRowMissing
		}
		return domain.OfficeSession{}, err
	}
	return s, nil
}

func (r *Repository) OfficeSessionByKey(ctx context.Context, key string) (domain.OfficeSession, error) {
	row := r.Q.QueryRow(ctx, officeSessionSelect+" WHERE document_key=$1", key)
	s, err := scanOfficeSession(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.OfficeSession{}, ports.ErrRowMissing
		}
		return domain.OfficeSession{}, err
	}
	return s, nil
}

func (r *Repository) LockOfficeSessionByKey(ctx context.Context, key string) error {
	var id string
	err := r.Q.QueryRow(ctx, "SELECT id FROM office_sessions WHERE document_key=$1 FOR UPDATE", key).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.ErrRowMissing
	}
	return err
}

func (r *Repository) ActiveOfficeSessionForFile(ctx context.Context, fileID string) (domain.OfficeSession, bool, error) {
	row := r.Q.QueryRow(ctx,
		officeSessionSelect+" WHERE file_id=$1 AND state IN('open','saving') AND expires_at>now() ORDER BY created_at DESC", fileID)
	s, err := scanOfficeSession(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.OfficeSession{}, false, nil
		}
		return domain.OfficeSession{}, false, err
	}
	return s, true, nil
}

func (r *Repository) SetOfficeSessionState(ctx context.Context, id, state string) error {
	_, err := r.Q.Exec(ctx, "UPDATE office_sessions SET state=$2 WHERE id=$1", id, state)
	return err
}

func (r *Repository) SetOfficeSessionBaseSeq(ctx context.Context, id string, seq int) error {
	_, err := r.Q.Exec(ctx, "UPDATE office_sessions SET base_seq=$2 WHERE id=$1", id, seq)
	return err
}

func (r *Repository) BumpOfficeSessionGeneration(ctx context.Context, id string) (int64, error) {
	var generation int64
	err := r.Q.QueryRow(ctx,
		"UPDATE office_sessions SET lock_generation=lock_generation+1 WHERE id=$1 RETURNING lock_generation", id).Scan(&generation)
	if err != nil {
		return 0, err
	}
	return generation, nil
}

func (r *Repository) TouchOfficeSession(ctx context.Context, id string, expires time.Time) error {
	_, err := r.Q.Exec(ctx, "UPDATE office_sessions SET expires_at=$2 WHERE id=$1", id, expires)
	return err
}

func (r *Repository) CloseOfficeSession(ctx context.Context, id string) error {
	_, err := r.Q.Exec(ctx,
		"UPDATE office_sessions SET state='abandoned',closed_at=now() WHERE id=$1 AND state IN('open','saving','pending')", id)
	return err
}

// ---------- idempotent save events ----------

func (r *Repository) SaveEventExists(ctx context.Context, sessionID, eventHash string) (bool, error) {
	var exists bool
	err := r.Q.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM office_save_events WHERE session_id=$1 AND event_hash=$2)", sessionID, eventHash).Scan(&exists)
	return exists, err
}

func (r *Repository) OfficeSaveEventOutcome(ctx context.Context, sessionID, eventHash string) (string, error) {
	var outcome string
	err := r.Q.QueryRow(ctx, "SELECT outcome FROM office_save_events WHERE session_id=$1 AND event_hash=$2",
		sessionID, eventHash).Scan(&outcome)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return outcome, err
}

func (r *Repository) OfficeNativeSaveCounts(ctx context.Context, sessionID string) (int64, int64, error) {
	var committed, failed int64
	err := r.Q.QueryRow(ctx, `SELECT count(*) FILTER (WHERE outcome='native_committed'),
		count(*) FILTER (WHERE outcome='native_failed')
		FROM office_save_events WHERE session_id=$1`, sessionID).Scan(&committed, &failed)
	return committed, failed, err
}

func (r *Repository) RecordSaveEvent(ctx context.Context, e domain.OfficeSaveEvent) error {
	_, err := r.Q.Exec(ctx,
		`INSERT INTO office_save_events(id,session_id,generation,callback_status,event_hash,outcome)
		 VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
		e.ID, e.SessionID, e.Generation, e.CallbackStatus, e.EventHash, e.Outcome)
	return err
}

// ---------- compatibility reports ----------

func (r *Repository) RecordCompatibilityReport(ctx context.Context, rep domain.OfficeCompatibilityReport) error {
	_, err := r.Q.Exec(ctx,
		`INSERT INTO office_compatibility_reports(file_id,version_seq,engine_version,supported_features,warnings,verification_status)
		 VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)
		 ON CONFLICT (file_id,version_seq) DO UPDATE SET engine_version=EXCLUDED.engine_version,
		   supported_features=EXCLUDED.supported_features,warnings=EXCLUDED.warnings,
		   verification_status=EXCLUDED.verification_status`,
		rep.FileID, rep.VersionSeq, rep.EngineVersion,
		marshalDetails(map[string]any{"features": rep.SupportedFeatures}),
		marshalDetails(map[string]any{"warnings": rep.Warnings}),
		rep.VerificationStatus)
	return err
}
