package main

import (
	"context"
	"filesmanage/internal/adapter/blob"
	"filesmanage/internal/adapter/postgres"
	"filesmanage/internal/application"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"log"
	"os"
	"time"
)

// blobStoreAdapter bridges the concrete blob store to the application port.
type blobStoreAdapter struct{ store *blob.Store }

func (a blobStoreAdapter) Stage() (ports.BlobStage, error) { return a.store.Stage() }
func (a blobStoreAdapter) Open(key string) (io.ReadSeekCloser, error) {
	return a.store.Open(key)
}

// reindex rebuilds the search index for files whose text row is missing
// (SPEC §10.1). It is the one-off backfill for databases created before
// indexing existed, and the ops recovery path after index corruption.
//
// Usage (on the target host):
//   DATABASE_URL=postgres://... FILESMANAGE_BLOB_DIR=.blobs ./filesmanage-reindex
func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL required")
	}
	blobDir := os.Getenv("FILESMANAGE_BLOB_DIR")
	if blobDir == "" {
		blobDir = ".blobs"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Hour)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	if err = pool.Ping(ctx); err != nil {
		log.Fatal("DB unavailable: ", err)
	}
	service := application.New(postgres.New(pool), blobStoreAdapter{store: blob.New(blobDir)})
	indexed, err := service.ReindexAllFiles(ctx, 200)
	if err != nil {
		log.Fatal("reindex failed after ", indexed, " files: ", err)
	}
	log.Printf("REINDEX_OK files=%d", indexed)
}
