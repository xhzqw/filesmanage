package ports

import (
	"context"
	"time"
)

// CDWEffectiveRead is resolved exclusively from the authoritative effective
// pointer and immutable issued artifact, never files.current_version_seq.
type CDWEffectiveRead struct {
	BlobID      string
	SHA256      string
	FileName    string
	Format      string
	EffectiveAt time.Time
}

type CDWEffectiveReadStore interface {
	// present=false means the file has never entered CDW effective management.
	// Once a pointer exists, invalid/none states must fail closed.
	CDWEffectiveRead(context.Context, string) (CDWEffectiveRead, bool, error)
}
