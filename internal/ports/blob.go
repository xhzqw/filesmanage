package ports

import "io"

// BlobStore is the application-facing contract for server-controlled blob
// storage. Implementations stream bytes to a staging area and publish them
// under content-addressed keys.
type BlobStore interface {
	Stage() (BlobStage, error)
	Open(storageKey string) (io.ReadSeekCloser, error)
}

// BlobStage is an in-progress blob upload.
type BlobStage interface {
	io.Writer
	Size() int64
	Sha256() string
	Commit() (storageKey string, deduplicated bool, err error)
	Abort() error
}
