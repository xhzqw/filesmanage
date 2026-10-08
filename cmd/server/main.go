package main

import (
	"context"
	"filesmanage/internal/adapter/blob"
	"filesmanage/internal/adapter/postgres"
	"filesmanage/internal/application"
	"filesmanage/internal/httpx"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

// blobStoreAdapter bridges the concrete blob store to the application port.
// Go interface satisfaction needs identical signatures, and *blob.Staged does
// satisfy ports.BlobStage, so only the factory return type is adapted here.
type blobStoreAdapter struct{ store *blob.Store }

func (a blobStoreAdapter) Stage() (ports.BlobStage, error) { return a.store.Stage() }
func (a blobStoreAdapter) Open(key string) (io.ReadSeekCloser, error) {
	return a.store.Open(key)
}

func isLoopbackAddr(addr string) bool {
	host := addr
	if h, _, err := net.SplitHostPort(addr); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL required")
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		log.Fatal("invalid DB configuration")
	}
	// Pool sizing is a capacity knob: the SPEC reference environment runs a
	// dedicated PostgreSQL, while shared hosts must keep the instance-wide
	// connection budget in mind (FILESMANAGE_DB_MAX_CONNS).
	maxConns := 10
	if raw := os.Getenv("FILESMANAGE_DB_MAX_CONNS"); raw != "" {
		if parsed, convErr := strconv.Atoi(raw); convErr == nil && parsed > 0 {
			maxConns = parsed
		}
	}
	config.MaxConns = int32(maxConns)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		log.Fatal("cannot create DB pool")
	}
	defer pool.Close()
	if err = pool.Ping(ctx); err != nil {
		log.Fatal("DB unavailable: ", err)
	}
	addr := os.Getenv("FILESMANAGE_ADDR")
	if addr == "" {
		addr = "127.0.0.1:18091"
	}
	secure := os.Getenv("FILESMANAGE_COOKIE_SECURE") == "true"
	// Default stays loopback-only. Cleartext cookies on a shared interface require the
	// explicit FILESMANAGE_ALLOW_LAN_HTTP=true opt-in so a config slip cannot expose
	// the dev service; httpx additionally enforces a source-IP allowlist.
	if !secure && !isLoopbackAddr(addr) && os.Getenv("FILESMANAGE_ALLOW_LAN_HTTP") != "true" {
		log.Fatal("cleartext cookies require loopback binding or FILESMANAGE_ALLOW_LAN_HTTP=true")
	}
	blobDir := os.Getenv("FILESMANAGE_BLOB_DIR")
	if blobDir == "" {
		blobDir = ".blobs"
	}
	store := blobStoreAdapter{store: blob.New(blobDir)}
	service := application.New(postgres.New(pool), store).WithOffice(application.OfficeConfig{
		EditorURL:     os.Getenv("FILESMANAGE_OFFICE_URL"),
		Secret:        os.Getenv("FILESMANAGE_OFFICE_SECRET"),
		SourceBaseURL: os.Getenv("FILESMANAGE_OFFICE_SOURCE_BASE"),
		EditorVersion: os.Getenv("FILESMANAGE_OFFICE_VERSION"),
	})
	r := httpx.New(service, secure, "web/dist")
	log.Println("filesmanage isolated development server listening ", addr)
	if err = r.Run(addr); err != nil {
		log.Fatal(err)
	}
}
