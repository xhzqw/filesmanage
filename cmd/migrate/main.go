package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

func main() {
	dir := flag.String("dir", "migrations", "directory of SQL up migrations")
	check := flag.Bool("check", false, "validate previously applied checksums without applying new ones")
	flag.Parse()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL must be set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		log.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(21007721)"); err != nil {
		log.Fatal(err)
	}
	_, err = tx.Exec(ctx, "CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())")
	if err != nil {
		log.Fatal(err)
	}
	entries, err := os.ReadDir(*dir)
	if err != nil {
		log.Fatal(err)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	processed := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		name := entry.Name()
		source, err := os.ReadFile(filepath.Join(*dir, name))
		if err != nil {
			log.Fatal(err)
		}
		sum := sha256.Sum256(source)
		hash := hex.EncodeToString(sum[:])
		var stored string
		err = tx.QueryRow(ctx, "SELECT checksum FROM schema_migrations WHERE version=$1", name).Scan(&stored)
		if err == nil {
			if stored != hash {
				log.Fatalf("migration changed after applied: %s", name)
			}
			fmt.Println("CHECK", name)
			processed++
			continue
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			log.Fatal(err)
		}
		if *check {
			log.Fatalf("migration not applied: %s", name)
		}
		if _, err = tx.Exec(ctx, string(source)); err != nil {
			log.Fatalf("migration %s: %v", name, err)
		}
		if _, err = tx.Exec(ctx, "INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", name, hash); err != nil {
			log.Fatal(err)
		}
		fmt.Println("APPLIED", name)
		processed++
	}
	if processed == 0 {
		log.Fatal("no SQL migrations found")
	}
	if err = tx.Commit(ctx); err != nil {
		log.Fatal(err)
	}
	fmt.Println("MIGRATIONS_OK", processed)
}
