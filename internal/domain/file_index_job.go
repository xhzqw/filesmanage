package domain

// FileIndexJob is a durable and lease-fenced request to refresh an immutable
// file version's search projection. The worker verifies the current version.
type FileIndexJob struct {
	ID         int64
	FileID     string
	VersionSeq int
	LeaseOwner string
}
