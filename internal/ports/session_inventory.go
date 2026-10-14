package ports

import (
	"context"
	"time"
)

// SessionRow is a public, non-bearer projection. ID is a truncated hash of the
// token (not the cookie); it cannot be used for session authentication.
type SessionRow struct {
	ID         string    `json:"id"`
	Device     string    `json:"device"`
	Address    string    `json:"address"`
	MACAddress string    `json:"macAddress"`
	CreatedAt  time.Time `json:"createdAt"`
	LastSeenAt time.Time `json:"lastSeenAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
	Current    bool      `json:"current"`
}

type AuthActivity struct {
	Type       string    `json:"type"`
	Outcome    string    `json:"outcome"`
	Device     string    `json:"device"`
	Address    string    `json:"address"`
	MACAddress string    `json:"macAddress"`
	Count      int       `json:"count,omitempty"`
	OccurredAt time.Time `json:"occurredAt"`
}

// SessionInventory supplements the existing Repository contract. A repository
// must scope all reads and revocations to the authenticated user inside SQL.
type SessionInventory interface {
	SessionOwner(context.Context, string) (string, error)
	SetSessionMetadata(context.Context, string, string, string, string) error
	TouchSession(context.Context, string) error
	ListOwnSessions(context.Context, string, string) ([]SessionRow, error)
	RevokeOwnSession(context.Context, string, string, string) (bool, error)
	RevokeOtherSessions(context.Context, string, string) (int64, error)
	ListOwnAuthActivity(context.Context, string) ([]AuthActivity, error)
}
