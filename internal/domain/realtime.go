package domain

// RealtimeEvent contains a replayable, anonymous invalidation. Resource
// identifiers and document content are intentionally excluded from the schema.
type RealtimeEvent struct {
	ID int64
	// UserID is used only by the server's internal replica-cache feed; it
	// is never serialized into public WebSocket event frames.
	UserID string
	Type   string
	Scopes []string
}
