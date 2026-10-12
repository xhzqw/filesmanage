package domain

// RealtimeEvent contains a replayable, anonymous invalidation. Resource
// identifiers and document content are intentionally excluded from the schema.
type RealtimeEvent struct {
	ID     int64
	Type   string
	Scopes []string
}
