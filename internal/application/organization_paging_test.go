package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"fmt"
	"testing"
)

func TestOrganizationKeysetPagesIncludeAllRows(t *testing.T) {
	s, repo := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	viewer := domain.User{ID: "u_guest"}
	for i := 0; i < 405; i++ {
		id := fmt.Sprintf("u_paged_%04d", i)
		repo.seedUser(domain.User{ID: id, Login: id, DisplayName: id}, "test-only")
	}
	for i := 0; i < 405; i++ {
		repo.workgroupList = append(repo.workgroupList, domain.Workgroup{
			ID: fmt.Sprintf("grp_paged_%04d", i), Name: fmt.Sprintf("Team %04d", i),
		})
	}
	if _, err := s.PageUsers(ctx, viewer, "", 200); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non-admin must not page users: %v", err)
	}
	if _, err := s.PageWorkgroups(ctx, viewer, "", 200); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non-admin must not page workgroups: %v", err)
	}
	for _, cursor := range []string{"a/b", "你好", "a b"} {
		if _, err := s.PageUsers(ctx, admin, cursor, 10); !errors.Is(err, domain.ErrInvalidInput) {
			t.Fatalf("accepted malformed cursor %q: %v", cursor, err)
		}
	}
	for _, limit := range []int{0, -1, 201, 1000} {
		if _, err := s.PageWorkgroups(ctx, admin, "", limit); !errors.Is(err, domain.ErrInvalidInput) {
			t.Fatalf("accepted invalid limit %d: %v", limit, err)
		}
	}
	seenUsers := map[string]bool{}
	cursor := ""
	for n := 0; n < 10; n++ {
		page, err := s.PageUsers(ctx, admin, cursor, 200)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Items) > 200 {
			t.Fatalf("oversize user page: %d", len(page.Items))
		}
		for _, u := range page.Items {
			if seenUsers[u.ID] {
				t.Fatalf("duplicate user across page: %s", u.ID)
			}
			seenUsers[u.ID] = true
		}
		if page.NextCursor == "" {
			break
		}
		if page.NextCursor <= cursor {
			t.Fatalf("cursor not advancing")
		}
		cursor = page.NextCursor
	}
	if len(seenUsers) != 407 {
		t.Fatalf("expected 407 users, received %d", len(seenUsers))
	}
	seenGroups := map[string]bool{}
	cursor = ""
	for n := 0; n < 10; n++ {
		page, err := s.PageWorkgroups(ctx, admin, cursor, 200)
		if err != nil {
			t.Fatal(err)
		}
		for _, g := range page.Items {
			if seenGroups[g.ID] {
				t.Fatalf("duplicate group across page: %s", g.ID)
			}
			seenGroups[g.ID] = true
		}
		if page.NextCursor == "" {
			break
		}
		if page.NextCursor <= cursor {
			t.Fatalf("group cursor not advancing")
		}
		cursor = page.NextCursor
	}
	if len(seenGroups) != 405 {
		t.Fatalf("expected 405 groups, received %d", len(seenGroups))
	}
}
