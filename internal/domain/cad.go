package domain

import (
	"crypto/rand"
	"encoding/hex"
	"time"
)

// NewID returns an opaque identifier with a readable prefix.
func NewID(prefix string) string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return prefix + "_" + hex.EncodeToString(raw)
}

// DerivativeJob is one claimed conversion unit claimed by the worker.
type DerivativeJob struct {
	JobID        string
	LeaseOwner   string
	DerivativeID string
	FileID       string
	VersionSeq   int
	SourceFormat string
	SourceSha256 string
	OutputKind   string
	Converter    string
}

// ModelDerivative is a browser-renderable asset derived from a file version.
// The original source bytes are never modified by previewing.
type ModelDerivative struct {
	ID               string
	FileID           string
	VersionSeq       int
	SourceSha256     string
	SourceFormat     string
	OutputKind       string
	BlobID           string
	StorageKey       string
	OutputSha256     string
	OutputSize       int64
	Converter        string
	ConverterVersion string
	SettingsHash     string
	State            string
	ErrorCode        string
	CreatedAt        time.Time
	StartedAt        *time.Time
	FinishedAt       *time.Time
}
