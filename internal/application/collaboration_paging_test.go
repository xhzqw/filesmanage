package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"fmt"
	"testing"
	"time"
)

// Both lists used to stop at 200/500. Every older row must now be reachable
// without duplicate IDs even when many rows share a timestamp.
func TestCollaborationKeysetBeyondLegacyCaps(t *testing.T) {
	s, r := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	member := domain.User{ID: "u_user"}
	when := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	rootID := "folder_root"
	for i := 0; i < 535; i++ {
		id := fmt.Sprintf("fav-%04d", i)
		r.favorites = append(r.favorites, domain.Favorite{
			ID: id, UserID: admin.ID, FolderID: &rootID, ResourceName: "根目录", CreatedAt: when,
		})
	}
	for i := 0; i < 237; i++ {
		r.shares = append(r.shares, domain.Share{
			ID: fmt.Sprintf("share-%04d", i), FolderID: &rootID, RecipientKind: "user",
			RecipientID: member.ID, CreatedBy: admin.ID, CreatedAt: when,
			Actions: []domain.Action{domain.ActionList},
		})
	}
	gotFav := map[string]bool{}
	cursor := ""
	for pageNo := 0; pageNo < 20; pageNo++ {
		page, err := s.ListFavoritesPage(ctx, admin, cursor, 50)
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range page.Items {
			if gotFav[f.ID] {
				t.Fatalf("favorite duplicate %s", f.ID)
			}
			gotFav[f.ID] = true
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	if len(gotFav) != 535 {
		t.Fatalf("favorites cap detected: %d/535", len(gotFav))
	}
	gotShares := map[string]bool{}
	cursor = ""
	for pageNo := 0; pageNo < 20; pageNo++ {
		page, err := s.ListSharesPage(ctx, member, "received", cursor, 40)
		if err != nil {
			t.Fatal(err)
		}
		for _, v := range page.Items {
			if gotShares[v.ID] {
				t.Fatalf("share duplicate %s", v.ID)
			}
			gotShares[v.ID] = true
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	if len(gotShares) != 237 {
		t.Fatalf("share cap detected: %d/237", len(gotShares))
	}
	first, err := s.ListSharesPage(ctx, admin, "sent", "", 5)
	if err != nil || len(first.Items) != 5 || first.NextCursor == "" {
		t.Fatalf("sent first page %+v %v", first, err)
	}
	if _, err = s.ListFavoritesPage(ctx, admin, first.NextCursor, 5); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("cross-scope cursor accepted: %v", err)
	}
	if _, err = s.ListSharesPage(ctx, admin, "sent", "invalid-cursor", 5); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("bad cursor accepted: %v", err)
	}
	if _, err = s.ListSharesPage(ctx, member, "sent", "", 5); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non-admin sent read: %v", err)
	}
}

func TestFavoriteBecomesUnavailableAndCanBeRemoved(t *testing.T) {
	s, r := testService(t)
	ctx := context.Background()
	member := domain.User{ID: "u_user"}
	folderID := "folder_market"
	r.favorites = append(r.favorites, domain.Favorite{
		ID: "fav-hidden", UserID: member.ID, FolderID: &folderID,
		ResourceName: "restricted secret", CreatedAt: time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC),
	})
	page, err := s.ListFavoritesPage(ctx, member, "", 10)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("get unavailable: %+v %v", page, err)
	}
	if !page.Items[0].Unavailable || page.Items[0].ResourceName != "不可访问的资源" {
		t.Fatalf("resource leaked: %+v", page.Items[0])
	}
	legacy, err := s.ListFavorites(ctx, member)
	if err != nil || len(legacy) != 1 || !legacy[0].Unavailable || legacy[0].ResourceName != "不可访问的资源" {
		t.Fatalf("legacy list leaked: %+v %v", legacy, err)
	}
	if err = s.SetFavorite(ctx, member, "folder", folderID, false); err != nil {
		t.Fatalf("must be able to remove inaccessible favorite: %v", err)
	}
	after, err := s.ListFavoritesPage(ctx, member, "", 10)
	if err != nil || len(after.Items) != 0 {
		t.Fatalf("favorite should disappear: %+v %v", after, err)
	}
	if err = s.SetFavorite(ctx, member, "folder", folderID, true); !errors.Is(err, domain.ErrForbidden) && !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("creating inaccessible favorite must fail: %v", err)
	}
}
