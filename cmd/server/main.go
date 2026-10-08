package main

import (
	"context"
	"filesmanage/internal/adapter/postgres"
	"filesmanage/internal/application"
	"filesmanage/internal/httpx"
	"github.com/jackc/pgx/v5/pgxpool"
	"log"
	"net"
	"os"
	"strings"
	"time"
)

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
	config.MaxConns = 10
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
	r := httpx.New(application.New(postgres.New(pool)), secure, "web/dist")
	log.Println("filesmanage isolated development server listening ", addr)
	if err = r.Run(addr); err != nil {
		log.Fatal(err)
	}
}
