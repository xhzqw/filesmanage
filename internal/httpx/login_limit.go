package httpx

import (
	"filesmanage/internal/application"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Budgets are per server process. Direct LAN clients use the socket peer;
// the loopback Nginx TLS ingress supplies an overwritten client IP header.
// Never trust this header from a direct LAN connection.
const (
	loginIPAttempts      = 30
	loginIPWindow        = 5 * time.Minute
	loginAccountAttempts = 10
	loginAccountWindow   = 10 * time.Minute
	loginLimitEntries    = 4096
	maxConcurrentLogins  = 8
)

type loginWindow struct {
	start time.Time
	count int
}
type loginLimiter struct {
	mu        sync.Mutex
	byIP      map[string]loginWindow
	byAccount map[string]loginWindow
	sem       chan struct{}
	now       func() time.Time
}

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{
		byIP:      make(map[string]loginWindow),
		byAccount: make(map[string]loginWindow),
		sem:       make(chan struct{}, maxConcurrentLogins),
		now:       time.Now,
	}
}
func checkLoginWindow(entries map[string]loginWindow, key string, now time.Time, window time.Duration, max int) time.Duration {
	current, found := entries[key]
	if !found || now.Sub(current.start) >= window {
		entries[key] = loginWindow{start: now, count: 1}
		return 0
	}
	if current.count >= max {
		return window - now.Sub(current.start)
	}
	current.count++
	entries[key] = current
	return 0
}
func pruneLoginWindows(entries map[string]loginWindow, now time.Time, window time.Duration) {
	for key, entry := range entries {
		if now.Sub(entry.start) >= window {
			delete(entries, key)
		}
	}
}

// allow atomically reserves both budgets. Names are digested to avoid storing
// raw login names. When the bounded table fills up, new keys fail closed.
// loginClientAddr uses the socket peer by default. For HTTPS traffic that
// traverses the loopback reverse proxy, Nginx overwrites the real client IP
// header. This avoids applying one shared 30-attempt IP budget to the entire
// office. Forwarding headers from direct LAN clients are never authoritative.
func loginClientAddr(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	peer := net.ParseIP(host)
	if peer == nil || !peer.IsLoopback() || r.Header.Get("X-Forwarded-Proto") != "https" {
		return r.RemoteAddr
	}
	ip := net.ParseIP(r.Header.Get("X-Filesmanage-Client-IP"))
	if ip == nil || ip.IsUnspecified() || ip.IsMulticast() {
		return r.RemoteAddr
	}
	return net.JoinHostPort(ip.String(), "0")
}

func (l *loginLimiter) allow(remoteAddr, login string) time.Duration {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil || net.ParseIP(host) == nil {
		return time.Minute
	}
	ip := net.ParseIP(host).String()
	account := application.HashToken(strings.ToLower(strings.TrimSpace(login)))
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	pruneLoginWindows(l.byIP, now, loginIPWindow)
	pruneLoginWindows(l.byAccount, now, loginAccountWindow)
	if len(l.byIP) >= loginLimitEntries {
		if _, known := l.byIP[ip]; !known {
			return loginIPWindow
		}
	}
	if len(l.byAccount) >= loginLimitEntries {
		if _, known := l.byAccount[account]; !known {
			return loginAccountWindow
		}
	}
	if wait := checkLoginWindow(l.byIP, ip, now, loginIPWindow, loginIPAttempts); wait > 0 {
		return wait
	}
	return checkLoginWindow(l.byAccount, account, now, loginAccountWindow, loginAccountAttempts)
}
func (l *loginLimiter) acquire() bool {
	select {
	case l.sem <- struct{}{}:
		return true
	default:
		return false
	}
}
func (l *loginLimiter) release() { <-l.sem }
func retrySeconds(wait time.Duration) int {
	if wait <= 0 {
		return 1
	}
	return int((wait + time.Second - 1) / time.Second)
}
