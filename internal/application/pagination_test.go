package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strconv"
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

// TestCachesAreBounded pins the memory bound: a cache never grows past
// maxCacheEntries, and expired entries are evicted rather than accumulated.
// Without this the maps would grow without limit on a long-running server
// with many users and varied filters.
func TestCachesAreBounded(t *testing.T) {
	clock := time.Date(2026, 10, 8, 13, 0, 0, 0, time.UTC)
	cache := statsCache{ttl: 30 * time.Second}
	for i := 0; i < maxCacheEntries+50; i++ {
		cache.put("key-"+strconvItoa(i), domain.Stats{TotalFiles: int64(i)}, clock, cache.revision)
	}
	cache.mu.Lock()
	size := len(cache.entries)
	cache.mu.Unlock()
	if size > maxCacheEntries {
		t.Fatalf("cache grew past the bound: %d entries (cap %d)", size, maxCacheEntries)
	}

	// Expired entries are dropped once the clock moves past the TTL, so a
	// steady-state server does not accumulate dead keys.
	clock = clock.Add(31 * time.Second)
	cache.put("fresh-key", domain.Stats{TotalFiles: 1}, clock, cache.revision)
	cache.mu.Lock()
	size = len(cache.entries)
	cache.mu.Unlock()
	if size != 1 {
		t.Fatalf("expired entries must be evicted, got %d entries, want 1", size)
	}
	if _, ok, _ := cache.get("fresh-key", clock); !ok {
		t.Fatal("the fresh entry must be readable")
	}
}

func strconvItoa(v int) string {
	return strconv.Itoa(v)
}

// seedSearchFile seeds a searchable file row directly: the search cursor tests
// need distinct sort keys (name, size and timestamp) that the upload fixture
// alone does not give.
func seedSearchFile(repo *memoryRepo, id, name string, size int64, updated time.Time) {
	repo.mu.Lock()
	defer repo.mu.Unlock()
	repo.files[id] = domain.File{
		ID: id, FolderID: "folder_market", Name: name, UploadedBy: "u_admin",
		ContentType: "text/plain", SizeBytes: size, UpdatedAt: updated,
	}
}

// TestSearchCursorPagesEveryMatchExactlyOnce pins WF-30 for every supported
// sort: the keyset cursor must cover each match exactly once — including
// size_desc, whose cursor branch silently used the updated_at key before — the
// pages must arrive in the sort's own order, and the authorized total must stay
// the same on every page instead of shrinking with the cursor.
func TestSearchCursorPagesEveryMatchExactlyOnce(t *testing.T) {
	s, repo := testService(t)
	admin := adminUser()
	ctx := context.Background()
	base := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	seedSearchFile(repo, "file_a", "alpha.txt", 30, base.Add(4*time.Minute))
	seedSearchFile(repo, "file_b", "bravo.txt", 50, base.Add(time.Minute))
	seedSearchFile(repo, "file_c", "charlie.txt", 10, base.Add(5*time.Minute))
	seedSearchFile(repo, "file_d", "delta.txt", 40, base.Add(2*time.Minute))
	seedSearchFile(repo, "file_e", "echo.txt", 20, base.Add(3*time.Minute))
	cases := []struct {
		sort string
		want []string
	}{
		{"updated_desc", []string{"file_c", "file_a", "file_e", "file_d", "file_b"}},
		{"name_asc", []string{"file_a", "file_b", "file_c", "file_d", "file_e"}},
		{"size_desc", []string{"file_b", "file_d", "file_a", "file_e", "file_c"}},
	}
	for _, tc := range cases {
		cursor := ""
		got := make([]string, 0, len(tc.want))
		pages := 0
		for {
			page, err := s.Search(ctx, admin, SearchFilter{FolderID: "folder_market", Sort: tc.sort, Cursor: cursor, Limit: 2})
			if err != nil {
				t.Fatalf("sort %s: %v", tc.sort, err)
			}
			if page.Total != len(tc.want) {
				t.Fatalf("sort %s: total = %d on page %d, want the authorized count %d", tc.sort, page.Total, pages+1, len(tc.want))
			}
			if len(page.Items) > 2 {
				t.Fatalf("sort %s: limit must cap the page, got %d rows", tc.sort, len(page.Items))
			}
			for _, item := range page.Items {
				got = append(got, item.ID)
			}
			pages++
			if page.NextCursor == "" {
				break
			}
			if pages > 6 {
				t.Fatalf("sort %s: cursor must terminate", tc.sort)
			}
			cursor = page.NextCursor
		}
		if pages != 3 {
			t.Fatalf("sort %s: 5 matches at limit 2 must page in 3 pages, got %d", tc.sort, pages)
		}
		if len(got) != len(tc.want) {
			t.Fatalf("sort %s: got %d rows, want %d", tc.sort, len(got), len(tc.want))
		}
		for i := range tc.want {
			if got[i] != tc.want[i] {
				t.Fatalf("sort %s: pages must follow the sort order, got %v want %v", tc.sort, got, tc.want)
			}
		}
		// A full last page exhausts the matches: no cursor is issued.
		full, err := s.Search(ctx, admin, SearchFilter{FolderID: "folder_market", Sort: tc.sort, Limit: len(tc.want)})
		if err != nil {
			t.Fatal(err)
		}
		if len(full.Items) != len(tc.want) || full.NextCursor != "" {
			t.Fatalf("sort %s: an exhausted page must return %d rows and no cursor, got %d rows cursor %q",
				tc.sort, len(tc.want), len(full.Items), full.NextCursor)
		}
	}
}

// TestSearchCursorIsTotalOnEqualKeys pins the stability promise: rows sharing
// the ordering key are paged by the id tie-break, so equal timestamps or sizes
// can neither skip nor duplicate a match.
func TestSearchCursorIsTotalOnEqualKeys(t *testing.T) {
	s, repo := testService(t)
	admin := adminUser()
	ctx := context.Background()
	base := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	for _, id := range []string{"file_t1", "file_t2", "file_t3"} {
		seedSearchFile(repo, id, id+".txt", 7, base)
	}
	for _, sort := range []string{"updated_desc", "size_desc"} {
		seen := map[string]int{}
		cursor := ""
		for page := 0; ; page++ {
			out, err := s.Search(ctx, admin, SearchFilter{FolderID: "folder_market", Sort: sort, Cursor: cursor, Limit: 1})
			if err != nil {
				t.Fatalf("sort %s: %v", sort, err)
			}
			for _, item := range out.Items {
				seen[item.ID]++
			}
			if out.NextCursor == "" {
				break
			}
			if page > 6 {
				t.Fatalf("sort %s: cursor must terminate", sort)
			}
			cursor = out.NextCursor
		}
		for _, id := range []string{"file_t1", "file_t2", "file_t3"} {
			if seen[id] != 1 {
				t.Fatalf("sort %s: %s returned %d times, want exactly once", sort, id, seen[id])
			}
		}
	}
}

// TestSearchIgnoresForgedCursor: a cursor the server did not issue restarts at
// the first page instead of failing the read — the same rule the paged folder
// reads follow.
func TestSearchIgnoresForgedCursor(t *testing.T) {
	s, repo := testService(t)
	admin := adminUser()
	ctx := context.Background()
	base := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	for i, id := range []string{"file_f1", "file_f2", "file_f3"} {
		seedSearchFile(repo, id, id+".txt", int64(10*(i+1)), base.Add(time.Duration(i)*time.Minute))
	}
	first, err := s.Search(ctx, admin, SearchFilter{FolderID: "folder_market", Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 2 || first.NextCursor == "" {
		t.Fatalf("the first page must be full and carry a cursor, got %d rows cursor %q", len(first.Items), first.NextCursor)
	}
	// The second value is valid base64 that carries no key separator.
	for _, forged := range []string{"!!!not-a-cursor!!!", "bm8tc2VwYXJhdG9y"} {
		page, err := s.Search(ctx, admin, SearchFilter{FolderID: "folder_market", Limit: 2, Cursor: forged})
		if err != nil {
			t.Fatalf("forged cursor %q must not fail the read: %v", forged, err)
		}
		if len(page.Items) != len(first.Items) || page.NextCursor != first.NextCursor {
			t.Fatalf("forged cursor %q must restart at page one: %d rows cursor %q", forged, len(page.Items), page.NextCursor)
		}
		for i := range page.Items {
			if page.Items[i].ID != first.Items[i].ID {
				t.Fatalf("forged cursor %q changed the first page: %s vs %s", forged, page.Items[i].ID, first.Items[i].ID)
			}
		}
	}
}
