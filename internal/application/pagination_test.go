package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"testing"
	"time"
)

func TestCursorRoundTrip(t *testing.T) {
	now := time.Date(2026, 10, 8, 13, 30, 0, 0, time.UTC)
	file := domain.File{ID: "file_x", Name: "报告.txt", SizeBytes: 2048, UpdatedAt: now}
	for _, sort := range []string{"updated_desc", "updated_asc", "name_asc", "name_desc", "size_desc"} {
		encoded := encodeCursor(sort, file)
		decoded := DecodeFileCursor(sort, encoded)
		if decoded.ID != file.ID {
			t.Fatalf("sort %s: cursor id = %q, want %q", sort, decoded.ID, file.ID)
		}
		switch sort {
		case "name_asc", "name_desc":
			if decoded.Name != file.Name {
				t.Fatalf("sort %s: cursor name = %q", sort, decoded.Name)
			}
		case "size_desc":
			if decoded.Size != file.SizeBytes {
				t.Fatalf("sort %s: cursor size = %d", sort, decoded.Size)
			}
		default:
			if !decoded.Time.Equal(now) {
				t.Fatalf("sort %s: cursor time = %v", sort, decoded.Time)
			}
		}
	}
	if empty := DecodeFileCursor("updated_desc", ""); empty.ID != "" {
		t.Fatal("empty cursor must decode to zero value")
	}
	if garbage := DecodeFileCursor("updated_desc", "!!!not-base64!!!"); garbage.ID != "" {
		t.Fatal("garbage cursor must decode to zero value")
	}
}

func TestListFilesAppliesPaginationLimit(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		if _, err := s.CommitUpload(t.Context(), admin, "folder_root", name, "text/plain", "", strings.NewReader("x")); err != nil {
			t.Fatal(err)
		}
	}
	page, err := s.ListFiles(t.Context(), admin, "folder_root", "", FileCursor{}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("limit must cap page, got %d", len(page.Items))
	}
	if page.NextCursor == "" {
		t.Fatal("more rows must yield a cursor")
	}
	next, err := s.ListFiles(t.Context(), admin, "folder_root", "", DecodeFileCursor("", page.NextCursor), 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(next.Items) != 1 {
		t.Fatalf("second page must return the remaining row, got %d", len(next.Items))
	}
	if next.Items[0].ID == page.Items[0].ID || next.Items[0].ID == page.Items[1].ID {
		t.Fatal("pages must not repeat rows")
	}
}

// The documented maximum page size must be honoured, not rejected: the
// repository receives page+1 lookahead rows, so an off-by-one guard turns a
// limit=MaxFilePage request into a 400. This pins the boundary.
func TestListFilesAcceptsMaxPageSize(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		if _, err := s.CommitUpload(t.Context(), admin, "folder_root", name, "text/plain", "", strings.NewReader("x")); err != nil {
			t.Fatal(err)
		}
	}
	for _, limit := range []int{ports.MaxFilePage, ports.MaxFilePage + 1, ports.MaxFilePage * 4} {
		page, err := s.ListFiles(t.Context(), admin, "folder_root", "", FileCursor{}, limit)
		if err != nil {
			t.Fatalf("limit %d must be clamped, not rejected: %v", limit, err)
		}
		if len(page.Items) != 3 {
			t.Fatalf("limit %d: got %d items", limit, len(page.Items))
		}
	}
	for _, sort := range []string{"updated_desc", "updated_asc", "name_asc", "name_desc", "size_desc"} {
		if _, err := s.ListFiles(t.Context(), admin, "folder_root", sort, FileCursor{}, ports.MaxFilePage); err != nil {
			t.Fatalf("sort %s at max page must succeed: %v", sort, err)
		}
	}
}

// TestSessionCacheRevokesImmediately pins the security property that makes the
// session cache acceptable: a cached session must stop validating the instant
// it is revoked, not after the cache TTL. Logout and account disabling both
// drop the cached entry.
func TestSessionCacheRevokesImmediately(t *testing.T) {
	s, repo := testService(t)
	ctx := context.Background()
	token, _, err := s.Login(ctx, "admin", "long-unit-test-password")
	if err != nil {
		t.Fatal(err)
	}
	// Warm the cache, then log out: the next validation must fail even though
	// the cached entry has not expired.
	if _, err = s.Session(ctx, token); err != nil {
		t.Fatalf("session not found: %v", err)
	}
	if err = s.Logout(ctx, token); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Session(ctx, token); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("revoked token accepted from the session cache")
	}

	// The same must hold for a disabled account.
	token2, _, err := s.Login(ctx, "user1", "long-unit-test-password")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Session(ctx, token2); err != nil {
		t.Fatalf("second session not found: %v", err)
	}
	if err = s.SetUserDisabled(ctx, domain.User{ID: "u_admin", IsAdmin: true}, "u_user", true); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Session(ctx, token2); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("disabled account's cached session still accepted")
	}
	_ = repo
}
