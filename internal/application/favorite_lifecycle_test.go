package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"fmt"
	"testing"
	"time"
)

func TestFavoriteDeleteRestorePurgeAndAccessIsolation(t *testing.T) {
	s, repo := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	viewer := domain.User{ID: "u_user"}
	fileID := "fav-lifecycle-file"
	repo.files[fileID] = domain.File{ID: fileID, FolderID: "folder_market", Name: "internal-design.pdf"}
	repo.favorites = append(repo.favorites,
		domain.Favorite{ID: "favorite-admin", UserID: admin.ID, FileID: &fileID, CreatedAt: time.Now()},
		domain.Favorite{ID: "favorite-viewer", UserID: viewer.ID, FileID: &fileID, CreatedAt: time.Now()},
	)
	removed, err := s.DeleteFile(ctx, admin, fileID)
	if err != nil {
		t.Fatal(err)
	}
	ownerPage, err := s.ListFavoritesPage(ctx, admin, "", 10)
	if err != nil || len(ownerPage.Items) != 1 || ownerPage.Items[0].Status != "trashed" ||
		ownerPage.Items[0].TrashEntryID != removed.ID {
		t.Fatalf("deleting owner should see authorized trash state: %+v %v", ownerPage, err)
	}
	viewerPage, err := s.ListFavoritesPage(ctx, viewer, "", 10)
	if err != nil || len(viewerPage.Items) != 1 || viewerPage.Items[0].Status != "inaccessible" ||
		viewerPage.Items[0].ResourceName != "不可访问的资源" ||
		viewerPage.Items[0].TrashEntryID != "" {
		t.Fatalf("inaccessible viewer should receive no deleted metadata: %+v %v", viewerPage, err)
	}
	if _, err = s.RestoreFromTrash(ctx, admin, removed.ID, RestoreRequest{}); err != nil {
		t.Fatal(err)
	}
	restored, err := s.ListFavoritesPage(ctx, admin, "", 10)
	if err != nil || len(restored.Items) != 1 || restored.Items[0].Status != "active" {
		t.Fatalf("restore should revive same favorite: %+v %v", restored, err)
	}
	if err = s.PurgeTrashEntry(ctx, admin, removed.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("restored trash entry must not be purged: %v", err)
	}
	removed, err = s.DeleteFile(ctx, admin, fileID)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.PurgeTrashEntry(ctx, admin, removed.ID); err != nil {
		t.Fatal(err)
	}
	for _, user := range []domain.User{admin, viewer} {
		page, e := s.ListFavoritesPage(ctx, user, "", 10)
		if e != nil || len(page.Items) != 0 {
			t.Fatalf("purged favorite remained for %s: %+v %v", user.ID, page, e)
		}
	}
}

func TestPurgeFolderRemovesDescendantFavoritesOnly(t *testing.T) {
	s, repo := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	top := "favorite-root"
	child := "favorite-child"
	insideFile := "favorite-inside"
	outside := "favorite-outside"
	repo.seedFolder(domain.Folder{ID: top, Name: "root", ParentID: stringPointer("folder_market"), OwnerID: admin.ID})
	repo.seedFolder(domain.Folder{ID: child, Name: "child", ParentID: &top, OwnerID: admin.ID})
	repo.files[insideFile] = domain.File{ID: insideFile, FolderID: child, Name: "model.dxf"}
	repo.files[outside] = domain.File{ID: outside, FolderID: "folder_market", Name: "other.pdf"}
	repo.favorites = []domain.Favorite{
		{ID: "folder-parent", UserID: admin.ID, FolderID: &top},
		{ID: "folder-child", UserID: admin.ID, FolderID: &child},
		{ID: "subtree-file", UserID: admin.ID, FileID: &insideFile},
		{ID: "unrelated", UserID: admin.ID, FileID: &outside},
	}
	entry, _, err := s.DeleteFolder(ctx, admin, top)
	if err != nil {
		t.Fatal(err)
	}
	page, err := s.ListFavoritesPage(ctx, admin, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, favorite := range page.Items {
		if favorite.ID == "subtree-file" && (favorite.Status != "trashed" || favorite.TrashEntryID != entry.ID) {
			t.Fatalf("nested favorite must point at ancestor's trash entry: %+v", favorite)
		}
	}
	if len(repo.favorites) != 4 {
		t.Fatal("soft deletion must not remove favorite relationships")
	}
	if err = s.PurgeTrashEntry(ctx, admin, entry.ID); err != nil {
		t.Fatal(err)
	}
	if len(repo.favorites) != 1 || repo.favorites[0].ID != "unrelated" {
		t.Fatalf("folder purge must only detach subtree favorites: %+v", repo.favorites)
	}
}

func TestSidebarFindsValidFavoriteBeyondUnavailablePages(t *testing.T) {
	s, repo := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	for i := 0; i < 175; i++ {
		id := fmt.Sprintf("missing-%03d", i)
		name := fmt.Sprintf("gone-%03d", i)
		repo.favorites = append(repo.favorites, domain.Favorite{ID: id, UserID: admin.ID, FolderID: &name, CreatedAt: time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC)})
	}
	root := "folder_root"
	for i := 0; i < 8; i++ {
		repo.favorites = append(repo.favorites, domain.Favorite{ID: fmt.Sprintf("valid-%02d", i), UserID: admin.ID, FolderID: &root, CreatedAt: time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)})
	}
	items, err := s.ListSidebarFavorites(ctx, admin)
	if err != nil || len(items) != 8 {
		t.Fatalf("sidebar should traverse past first page: %d %v", len(items), err)
	}
	for _, f := range items {
		if f.Status != "active" || f.Unavailable {
			t.Fatalf("inaccessible shortcut returned: %+v", f)
		}
	}
}
