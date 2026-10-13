package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"testing"
)

func TestFinderFolderLabelsAndAtomicMixedDrop(t *testing.T) {
	ctx := context.Background()
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	member := domain.User{ID: "u_user"}
	labels, err := s.FinderLabels(ctx, admin)
	if err != nil || len(labels) != 7 {
		t.Fatalf("default labels: %v", err)
	}
	labelID := labels[0].ID
	fileID := "file_tag_mix"
	folderID := "folder_market"
	repo.files[fileID] = domain.File{ID: fileID, FolderID: "folder_root", Name: "报告.txt", UploadedBy: admin.ID}
	if err = s.SetFinderResources(ctx, admin, labelID, []string{fileID}, []string{folderID}, true); err != nil {
		t.Fatal(err)
	}
	files, err := s.FinderTaggedFiles(ctx, admin, labelID)
	if err != nil || len(files) != 1 || files[0].ID != fileID {
		t.Fatalf("files: %+v %v", files, err)
	}
	folders, err := s.FinderTaggedFolders(ctx, admin, labelID)
	if err != nil || len(folders) != 1 || folders[0].ID != folderID {
		t.Fatalf("folders: %+v %v", folders, err)
	}
	current, err := s.FinderFolderLabels(ctx, admin, folderID)
	if err != nil || len(current) != 1 || current[0] != labelID {
		t.Fatalf("folder colors: %+v %v", current, err)
	}
	if err = s.SetFinderResources(ctx, member, labelID, nil, []string{folderID}, true); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("another user's label should be inaccessible: %v", err)
	}
	memberLabels, err := s.FinderLabels(ctx, member)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetFinderResources(ctx, member, memberLabels[0].ID, nil, []string{folderID}, true); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("folder ACL not checked: %v", err)
	}
	if err = s.SetFinderResources(ctx, admin, labelID, []string{fileID}, []string{"folder_missing"}, false); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("invalid mixed drop should fail: %v", err)
	}
	currentFile, err := s.FinderFileLabels(ctx, admin, fileID)
	if err != nil || len(currentFile) != 1 {
		t.Fatalf("failure changed file tagging: %+v %v", currentFile, err)
	}
	if err = s.SetFinderResources(ctx, admin, labelID, []string{fileID}, []string{folderID}, false); err != nil {
		t.Fatal(err)
	}
	files, err = s.FinderTaggedFiles(ctx, admin, labelID)
	if err != nil || len(files) != 0 {
		t.Fatalf("file not untagged: %+v %v", files, err)
	}
	folders, err = s.FinderTaggedFolders(ctx, admin, labelID)
	if err != nil || len(folders) != 0 {
		t.Fatalf("folder not untagged: %+v %v", folders, err)
	}
	// Tagging does not mutate hierarchy or create a second physical folder.
	original := repo.folders[folderID]
	if original.ParentID == nil || *original.ParentID != "folder_root" {
		t.Fatalf("folder unexpectedly moved: %+v", original)
	}
}
