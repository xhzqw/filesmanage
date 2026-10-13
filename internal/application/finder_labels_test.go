package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"testing"
)

func TestFinderLabelsPersonalNamesAssignmentsAndPermissions(t *testing.T) {
	s, repo := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	member := domain.User{ID: "u_user"}
	adminLabels, err := s.FinderLabels(ctx, admin)
	if err != nil || len(adminLabels) != 7 {
		t.Fatalf("admin default palette: %v %+v", err, adminLabels)
	}
	memberLabels, err := s.FinderLabels(ctx, member)
	if err != nil || len(memberLabels) != 7 {
		t.Fatalf("member default palette: %v %+v", err, memberLabels)
	}
	if adminLabels[0].ID == memberLabels[0].ID {
		t.Fatal("users share one palette")
	}
	red := adminLabels[0]
	if red.Color != "red" || red.Name != "红色" {
		t.Fatalf("unexpected default: %+v", red)
	}
	renamed, err := s.UpdateFinderLabel(ctx, admin, red.ID, "重要", red.Color)
	if err != nil || renamed.Name != "重要" {
		t.Fatalf("rename: %v %+v", err, renamed)
	}
	if _, err = s.UpdateFinderLabel(ctx, admin, red.ID, "重要", "blue"); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("default color mutation accepted: %v", err)
	}
	custom, err := s.CreateFinderLabel(ctx, admin, "仪器台账", "blue")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateFinderLabel(ctx, admin, "仪器台账", "red"); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("duplicate allowed: %v", err)
	}
	if _, err = s.UpdateFinderLabel(ctx, member, custom.ID, "我的标签", "blue"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("cross-user rename: %v", err)
	}
	file := domain.File{ID: "file_finder_one", FolderID: "folder_root", Name: "仪器手册.pdf", UploadedBy: admin.ID}
	repo.files[file.ID] = file
	if err = s.SetFinderFiles(ctx, admin, red.ID, []string{file.ID}, true); err != nil {
		t.Fatal(err)
	}
	if err = s.SetFinderFiles(ctx, admin, custom.ID, []string{file.ID}, true); err != nil {
		t.Fatal(err)
	}
	ids, err := s.FinderFileLabels(ctx, admin, file.ID)
	if err != nil || len(ids) != 2 {
		t.Fatalf("multi-label assignment: %v %+v", err, ids)
	}
	docs, err := s.FinderTaggedFiles(ctx, admin, red.ID)
	if err != nil || len(docs) != 1 || docs[0].ID != file.ID {
		t.Fatalf("tag query: %v %+v", err, docs)
	}
	if err = s.SetFinderFiles(ctx, member, red.ID, []string{file.ID}, true); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("cross-user label access: %v", err)
	}
	if err = s.SetFinderFiles(ctx, member, memberLabels[0].ID, []string{file.ID}, true); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("unauthorized file assignment: %v", err)
	}
	if err = s.SetFinderFiles(ctx, admin, red.ID, []string{file.ID, file.ID}, false); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("duplicate file ids accepted: %v", err)
	}
	if err = s.RemoveFinderLabel(ctx, admin, red.ID); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("deleted system color: %v", err)
	}
	if err = s.RemoveFinderLabel(ctx, admin, custom.ID); err != nil {
		t.Fatal(err)
	}
	ids, err = s.FinderFileLabels(ctx, admin, file.ID)
	if err != nil || len(ids) != 1 || ids[0] != red.ID {
		t.Fatalf("delete label must retain file and other tags: %v %+v", err, ids)
	}
	if err = s.SetFinderFiles(ctx, admin, red.ID, []string{file.ID}, false); err != nil {
		t.Fatal(err)
	}
	ids, err = s.FinderFileLabels(ctx, admin, file.ID)
	if err != nil || len(ids) != 0 {
		t.Fatalf("unmark: %v %+v", err, ids)
	}
}
