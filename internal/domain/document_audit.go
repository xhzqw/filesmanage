package domain

// DocumentAuditFilter constrains a keyset read to document lifecycle activity.
// Only system administrators and global auditors can query this projection.
type DocumentAuditFilter struct {
	BeforeID    int64
	Limit       int
	FileID      string
	ActorID     string
	EventPrefix string
}
