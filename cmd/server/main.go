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
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// blobStoreAdapter bridges the concrete blob store to the application port.
// Go interface satisfaction needs identical signatures, and *blob.Staged does
// satisfy ports.BlobStage, so only the factory return type is adapted here.
type blobStoreAdapter struct{ store *blob.Store }

func (a blobStoreAdapter) Stage() (ports.BlobStage, error) { return a.store.Stage() }
func (a blobStoreAdapter) SweepStaging(maxAge time.Duration) (int, error) {
	return a.store.SweepStaging(maxAge)
}
func (a blobStoreAdapter) Open(key string) (io.ReadSeekCloser, error) {
	return a.store.Open(key)
}
func (a blobStoreAdapter) AppendResumable(id string, offset int64, data []byte) error {
	return a.store.AppendResumable(id, offset, data)
}
func (a blobStoreAdapter) OpenResumable(id string) (io.ReadCloser, int64, error) {
	return a.store.OpenResumable(id)
}
func (a blobStoreAdapter) RemoveResumable(id string) error { return a.store.RemoveResumable(id) }

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
	runCtx, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopSignals()
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
	// Recycle long-held pooled connections gradually, without a reconnect
	// storm. The shared PostgreSQL budget remains operator-controlled.
	config.MaxConnLifetime = 30 * time.Minute
	config.MaxConnLifetimeJitter = 5 * time.Minute
	config.MaxConnIdleTime = 10 * time.Minute
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
	// Fail startup closed if the persistent event migration is missing. A live
	// service must not silently downgrade to volatile in-memory notifications.
	if _, _, err = postgres.New(pool).RealtimeBounds(ctx); err != nil {
		log.Fatal("persistent realtime journal unavailable; run migrations: ", err)
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
	// AG09 crash recovery: an upload that died between staging and the database
	// commit leaves a staging file behind. Sweeping at startup keeps the store
	// from growing without bound after crashes; the one-hour age keeps any
	// in-flight upload of a concurrently running process alive.
	if swept, sweepErr := store.SweepStaging(time.Hour); sweepErr != nil {
		log.Printf("staging sweep failed: %v", sweepErr)
	} else if swept > 0 {
		log.Printf("staging sweep removed %d orphaned upload(s)", swept)
	}
	cleanupResumable := func() {
		if swept, err := store.store.SweepResumable(48 * time.Hour); err != nil {
			log.Printf("resumable sweep: %v", err)
		} else if swept > 0 {
			log.Printf("resumable sweep removed %d expired file(s)", swept)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if deleted, err := postgres.New(pool).PruneExpiredResumableUploads(ctx); err != nil {
			log.Printf("resumable session cleanup: %v", err)
		} else if deleted > 0 {
			log.Printf("pruned %d expired upload sessions", deleted)
		}
	}
	cleanupResumable()
	var maintenance sync.WaitGroup
	startMaintenance := func(fn func()) {
		maintenance.Add(1)
		go func() {
			defer maintenance.Done()
			fn()
		}()
	}
	startMaintenance(func() {
		tick := time.NewTicker(time.Hour)
		defer tick.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-tick.C:
				cleanupResumable()
			}
		}
	})
	service := application.New(postgres.New(pool), store).WithDurableEvents(postgres.New(pool)).WithOffice(application.OfficeConfig{
		EditorURL:     os.Getenv("FILESMANAGE_OFFICE_URL"),
		Secret:        os.Getenv("FILESMANAGE_OFFICE_SECRET"),
		SourceBaseURL: os.Getenv("FILESMANAGE_OFFICE_SOURCE_BASE"),
		EditorVersion: os.Getenv("FILESMANAGE_OFFICE_VERSION"),
	})
	// App replicas must also invalidate HTTP read caches without connected WS
	// clients; each process follows the same committed PostgreSQL journal.
	startMaintenance(func() { service.WatchDurableCache(runCtx) })
	// Durable due-date reminders. At startup and hourly; duplicate instances
	// are safe because PostgreSQL enforces one notification per due date/phase.
	remindLifecycle := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if count, e := postgres.New(pool).GenerateLifecycleNotifications(ctx, time.Now().UTC()); e != nil {
			log.Printf("lifecycle reminders failed: %v", e)
		} else if count > 0 {
			log.Printf("lifecycle reminders enqueued: %d", count)
		}
	}
	remindLifecycle()
	startMaintenance(func() {
		tick := time.NewTicker(time.Hour)
		defer tick.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-tick.C:
				remindLifecycle()
			}
		}
	})
	// Persistent event retention: defaults to 90 days. Set 0 for indefinite
	// retention; deletion is capped to keep each maintenance pass bounded.
	retentionDays := 90
	if raw := os.Getenv("FILESMANAGE_REALTIME_RETENTION_DAYS"); raw != "" {
		if days, parseErr := strconv.Atoi(raw); parseErr == nil && days >= 0 && days <= 36500 {
			retentionDays = days
		}
	}
	pruneRealtime := func() {
		if retentionDays == 0 {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if count, e := postgres.New(pool).PruneRealtimeEvents(ctx, retentionDays, 5000); e != nil {
			log.Printf("realtime retention failed: %v", e)
		} else if count > 0 {
			log.Printf("realtime retention removed %d old hints", count)
		}
	}
	pruneRealtime()
	startMaintenance(func() {
		tick := time.NewTicker(24 * time.Hour)
		defer tick.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-tick.C:
				pruneRealtime()
			}
		}
	})
	r := httpx.New(service, secure, "web/dist")
	log.Println("filesmanage isolated development server listening ", addr)
	server := &http.Server{
		Addr: addr, Handler: r,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		// No global WriteTimeout: Range downloads and large uploads must
		// remain streaming; their individual handlers enforce limits.
		BaseContext: func(net.Listener) context.Context { return runCtx },
	}
	stopped := make(chan struct{})
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		select {
		case <-runCtx.Done():
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			if err := server.Shutdown(shutdownCtx); err != nil {
				log.Printf("graceful HTTP shutdown exceeded deadline: %v", err)
				_ = server.Close()
			}
		case <-stopped:
		}
	}()
	err = server.ListenAndServe()
	close(stopped)
	stopSignals()
	// Shutdown may still be draining HTTP requests after the listener closes.
	// Do not close the database pool until that drain has completed.
	<-shutdownDone
	if err != nil && err != http.ErrServerClosed {
		log.Printf("HTTP listener stopped unexpectedly: %v", err)
	}
	maintenance.Wait()
}
