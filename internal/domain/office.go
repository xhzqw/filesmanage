package domain

import "time"

// OfficeSession is a live DOCX editing session served by the external document
// editor. The session pins a base version; saves arrive through the callback
// endpoint and must be idempotent per (session, event).
type OfficeSession struct {
	ID             string
	FileID         string
	OwnerID        string
	BaseSeq        int
	DocumentKey    string
	State          string
	LockGeneration int64
	ExpiresAt      time.Time
	CreatedAt      time.Time
	ClosedAt       *time.Time
}

// OfficeSession lifecycle states (schema CHECK allows exactly these).
const (
	OfficeStateOpen      = "open"
	OfficeStateSaving    = "saving"
	OfficeStatePending   = "pending"
	OfficeStateCommitted = "committed"
	OfficeStateFailed    = "failed"
	OfficeStateAbandoned = "abandoned"
)

// Document server callback statuses (ONLYOFFICE contract).
const (
	CallbackStatusEditing     = 1
	CallbackStatusSaveReady   = 2
	CallbackStatusSaveError   = 3
	CallbackStatusClosed      = 4
	CallbackStatusForceSave   = 6
	CallbackStatusCorrupted   = 7
)

// OfficeSaveEvent records one processed callback so replays are no-ops.
type OfficeSaveEvent struct {
	ID              string
	SessionID       string
	Generation      int64
	CallbackStatus  int
	EventHash       string
	Outcome         string
	CreatedAt       time.Time
}

// OfficeCompatibilityReport records editor fidelity per file version.
type OfficeCompatibilityReport struct {
	FileID             string
	VersionSeq         int
	EngineVersion      string
	SupportedFeatures  []string
	Warnings           []string
	VerificationStatus string
}
