package application

import (
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"fmt"
	"testing"
	"time"
)

// Paged folder read tests (COMPLEX-WORKFLOWS §2.3 / ADR-UX-07): the children and
// search endpoints must stay visible-only, stable under a keyset cursor and
// completely read-only.

func seedChild(repo *memoryRepo, id, name, parentID string) {
	repo.seedFolder(domain.Folder{ID: id, Name: name, ParentID: strPtr(parentID), OwnerID: "u_admin"})
}

// seedDeletedFolder seeds a soft-deleted folder so a read can prove it answers
// exactly like a missing id.
func seedDeletedFolder(repo *memoryRepo, id, name string) {
	deletedAt := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	repo.seedFolder(domain.Folder{ID: id, Name: name, ParentID: strPtr("folder_root"), OwnerID: "u_admin", DeletedAt: &deletedAt})
}

// readFootprint captures the writable state the two read endpoints must leave
// untouched.
func readFootprint(repo *memoryRepo) string {
	repo.mu.Lock()
	defer repo.mu.Unlock()
	return fmt.Sprintf("audit=%d idem=%d trash=%d folders=%d files=%d",
		len(repo.audit), len(repo.idempotency), len(repo.trash), len(repo.folders), len(repo.files))
}

func folderIDsOf(items []FolderPageItem) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, item.ID)
	}
	return out
}

func adminUser() domain.User { return domain.User{ID: "u_admin", Login: "admin", IsAdmin: true} }

func TestVisibleFolderResolvesDeepLinkWithoutLeakingHiddenFolders(t *testing.T) {
	s, repo := testService(t)
	admin := adminUser()
	user := domain.User{ID: "u_user", Login: "user1"}
	folder, err := s.VisibleFolder(t.Context(), admin, "folder_market")
	if err != nil || folder.ID != "folder_market" || folder.Name != "市场部" {
		t.Fatalf("admin deep link must resolve the exact folder: %+v %v", folder, err)
	}
	for _, id := range []string{"folder_market", "folder_missing", ""} {
		if _, err = s.VisibleFolder(t.Context(), user, id); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("hidden/missing folder %q must be indistinguishable: %v", id, err)
		}
	}
	repo.seedGrant(domain.ACL{ID: "acl_deep", FolderID: "folder_market", SubjectKind: "user", SubjectID: "u_user", Actions: []domain.Action{domain.ActionList}, ScopeOnly: true})
	folder, err = s.VisibleFolder(t.Context(), user, "folder_market")
	if err != nil || folder.ID != "folder_market" {
		t.Fatalf("authorized direct link failed: %+v %v", folder, err)
	}
	if _, err = s.VisibleFolder(t.Context(), user, "folder_root"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("hidden ancestor leaked after granting child: %v", err)
	}
}

func TestFolderChildrenListsRootsAndChildPage(t *testing.T) {
	s, repo := testService(t)
	admin := adminUser()
	seedChild(repo, "folder_rd", "研发部", "folder_root")
	seedChild(repo, "folder_archive", "归档", "folder_market")

	roots, err := s.FolderChildren(t.Context(), admin, "", FolderCursor{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(roots.Items) != 1 || roots.Items[0].ID != "folder_root" {
		t.Fatalf("roots must hold the single top-level folder, got %v", folderIDsOf(roots.Items))
	}
	if roots.Items[0].ParentID != nil {
		t.Fatalf("a root row must carry a null parentId, got %+v", roots.Items[0])
	}
	if !roots.Items[0].HasChildren || !roots.Items[0].CanSelect || roots.Items[0].DisabledReason != "" {
		t.Fatalf("unexpected root row %+v", roots.Items[0])
	}
	if roots.NextCursor != "" {
		t.Fatalf("a complete page must not carry a cursor, got %q", roots.NextCursor)
	}

	// Name then id order, and hasChildren reflects the real child set.
	page, err := s.FolderChildren(t.Context(), admin, "folder_root", FolderCursor{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if got := folderIDsOf(page.Items); len(got) != 2 || got[0] != "folder_market" || got[1] != "folder_rd" {
		t.Fatalf("children must be name-ordered, got %v", got)
	}
	if !page.Items[0].HasChildren {
		t.Fatal("市场部 has a child, hasChildren must be true")
	}
	if page.Items[1].HasChildren {
		t.Fatal("研发部 is a leaf, hasChildren must be false")
	}
}

func TestFolderChildrenPagesEveryChildExactlyOnce(t *testing.T) {
	s, repo := testService(t)
	admin := adminUser()
	for _, name := range []string{"aa", "bb", "cc", "dd", "ee"} {
		seedChild(repo, "folder_"+name, name, "folder_root")
	}
	seen := map[string]int{}
	cursor := FolderCursor{}
	pages := 0
	for {
		page, err := s.FolderChildren(t.Context(), admin, "folder_root", cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Items) > 2 {
			t.Fatalf("limit must cap the page, got %d rows", len(page.Items))
		}
		for _, item := range page.Items {
			seen[item.ID]++
		}
		pages++
		if page.NextCursor == "" {
			break
		}
		if pages > 10 {
			t.Fatal("cursor must terminate")
		}
		cursor = DecodeFolderCursor(page.NextCursor)
	}
	// 5 seeded children plus the fixture's folder_market.
	if len(seen) != 6 || pages != 3 {
		t.Fatalf("paging must cover every folder once: %d folders over %d pages", len(seen), pages)
	}
	for id, count := range seen {
		if count != 1 {
			t.Fatalf("%s returned %d times", id, count)
		}
	}
}

// TestFolderChildrenTieBreaksEqualNamesByID pins the (name,id) keyset: two
// live siblings cannot share a name in PostgreSQL, but the cursor must still be
// total if they ever do.
func TestFolderChildrenTieBreaksEqualNamesByID(t *testing.T) {
	s, repo := testService(t)
	admin := adminUser()
	seedChild(repo, "folder_dup_a", "同名目录", "folder_root")
	seedChild(repo, "folder_dup_b", "同名目录", "folder_root")
	seen := map[string]int{}
	cursor := FolderCursor{}
	for page := 0; ; page++ {
		out, err := s.FolderChildren(t.Context(), admin, "folder_root", cursor, 1)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range out.Items {
			seen[item.ID]++
		}
		if out.NextCursor == "" {
			break
		}
		if page > 6 {
			t.Fatal("cursor must terminate")
		}
		cursor = DecodeFolderCursor(out.NextCursor)
	}
	for _, id := range []string{"folder_dup_a", "folder_dup_b", "folder_market"} {
		if seen[id] != 1 {
			t.Fatalf("%s returned %d times, want exactly once", id, seen[id])
		}
	}
}

func TestFolderChildrenClampsPageSize(t *testing.T) {
	s, repo := testService(t)
	admin := adminUser()
	for i := 0; i < ports.MaxFolderPage+5; i++ {
		seedChild(repo, fmt.Sprintf("folder_bulk_%03d", i), fmt.Sprintf("批量目录 %03d", i), "folder_root")
	}
	capped, err := s.FolderChildren(t.Context(), admin, "folder_root", FolderCursor{}, 5000)
	if err != nil {
		t.Fatal(err)
	}
	if len(capped.Items) != ports.MaxFolderPage {
		t.Fatalf("server cap must clamp the page to %d, got %d", ports.MaxFolderPage, len(capped.Items))
	}
	if capped.NextCursor == "" {
		t.Fatal("a clamped page must carry the cursor for the rest")
	}
	def, err := s.FolderChildren(t.Context(), admin, "folder_root", FolderCursor{}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(def.Items) != folderPageDefault {
		t.Fatalf("an absent limit must default to %d, got %d", folderPageDefault, len(def.Items))
	}
}

func TestFolderChildrenOmitUnlistableChildren(t *testing.T) {
	s, repo := testService(t)
	user := domain.User{ID: "u_user", Login: "user1"}
	seedChild(repo, "folder_hr", "人力资源", "folder_market")
	seedChild(repo, "folder_hr_report", "薪酬报表", "folder_hr")
	seedChild(repo, "folder_secret", "保密目录", "folder_market")
	// scope_only keeps the grants on the two folders themselves, which is the
	// only way a listable parent can still have children the caller cannot see.
	repo.seedGrant(domain.ACL{ID: "acl_market", FolderID: "folder_market", SubjectKind: "user", SubjectID: "u_user",
		Actions: []domain.Action{domain.ActionList, domain.ActionUpload}, ScopeOnly: true})
	repo.seedGrant(domain.ACL{ID: "acl_hr", FolderID: "folder_hr", SubjectKind: "user", SubjectID: "u_user",
		Actions: []domain.Action{domain.ActionList}, ScopeOnly: true})

	page, err := s.FolderChildren(t.Context(), user, "folder_market", FolderCursor{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != "folder_hr" {
		t.Fatalf("only the listable child may appear, got %v", folderIDsOf(page.Items))
	}
	if page.Items[0].HasChildren {
		t.Fatal("a hidden child must not make hasChildren true")
	}
	if page.Items[0].CanSelect || page.Items[0].DisabledReason != disabledReasonUpload {
		t.Fatalf("list-only 人力资源 must be disabled: %+v", page.Items[0])
	}

	// The pruned subtree surfaces as an accessible root; its parentId still names
	// the real parent so the client can detect the orphan, and the hidden
	// ancestor is never listed.
	roots, err := s.FolderChildren(t.Context(), user, "", FolderCursor{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(roots.Items) != 1 || roots.Items[0].ID != "folder_market" {
		t.Fatalf("the visible subtree must surface as one root, got %v", folderIDsOf(roots.Items))
	}
	if roots.Items[0].ParentID == nil || *roots.Items[0].ParentID != "folder_root" {
		t.Fatalf("an orphan root keeps its real parentId, got %+v", roots.Items[0])
	}
	if !roots.Items[0].HasChildren {
		t.Fatal("市场部 has a visible child, hasChildren must be true")
	}
	// The same page names no hidden folder.
	if _, err := s.FolderChildren(t.Context(), user, "folder_root", FolderCursor{}, 50); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("the hidden ancestor must not be reachable, got %v", err)
	}

	// The admin sees both children and the deeper leaf.
	adminPage, err := s.FolderChildren(t.Context(), adminUser(), "folder_market", FolderCursor{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if got := folderIDsOf(adminPage.Items); len(got) != 2 {
		t.Fatalf("admin must see both children, got %v", got)
	}
	if !adminPage.Items[0].HasChildren && !adminPage.Items[1].HasChildren {
		t.Fatal("人力资源 has a child, hasChildren must be true")
	}
}

// TestFolderChildrenHiddenDeletedAndMissingParentAnswerAlike pins SAFE-04: a
// parent the caller may not list, a soft-deleted parent and an unknown id must
// all answer E_NOT_FOUND, so probing learns nothing.
func TestFolderChildrenHiddenDeletedAndMissingParentAnswerAlike(t *testing.T) {
	s, repo := testService(t)
	user := domain.User{ID: "u_user", Login: "user1"}
	repo.seedGrant(domain.ACL{ID: "acl_market", FolderID: "folder_market", SubjectKind: "user", SubjectID: "u_user",
		Actions: []domain.Action{domain.ActionList}})
	seedDeletedFolder(repo, "folder_gone", "已删目录")

	for _, parentID := range []string{"folder_root", "folder_gone", "folder_missing"} {
		page, err := s.FolderChildren(t.Context(), user, parentID, FolderCursor{}, 50)
		if !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("parent %s must answer not found, got %v", parentID, err)
		}
		if errors.Is(err, domain.ErrForbidden) {
			t.Fatalf("parent %s must not answer forbidden", parentID)
		}
		if len(page.Items) != 0 {
			t.Fatalf("parent %s must not leak rows", parentID)
		}
	}
	// The same caller does see the granted subtree, so the 404 is about visibility
	// and not about a broken fixture.
	if _, err := s.FolderChildren(t.Context(), user, "folder_market", FolderCursor{}, 50); err != nil {
		t.Fatalf("granted parent must be readable: %v", err)
	}
}

func TestFolderChildrenCanSelectFollowsUploadPermission(t *testing.T) {
	s, repo := testService(t)
	user := domain.User{ID: "u_user", Login: "user1"}
	seedChild(repo, "folder_archive", "归档", "folder_root")
	seedChild(repo, "folder_team", "项目组", "folder_market")
	// scope_only keeps the root grant on the root itself, so 归档 owns its
	// list-only verdict; 市场部 carries upload and passes it to its children.
	repo.seedGrant(domain.ACL{ID: "acl_root", FolderID: "folder_root", SubjectKind: "user", SubjectID: "u_user",
		Actions: []domain.Action{domain.ActionList, domain.ActionUpload}, ScopeOnly: true})
	repo.seedGrant(domain.ACL{ID: "acl_archive", FolderID: "folder_archive", SubjectKind: "user", SubjectID: "u_user",
		Actions: []domain.Action{domain.ActionList}, ScopeOnly: true})
	repo.seedGrant(domain.ACL{ID: "acl_market", FolderID: "folder_market", SubjectKind: "user", SubjectID: "u_user",
		Actions: []domain.Action{domain.ActionList, domain.ActionUpload}})

	page, err := s.FolderChildren(t.Context(), user, "folder_root", FolderCursor{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if got := folderIDsOf(page.Items); len(got) != 2 || got[0] != "folder_market" || got[1] != "folder_archive" {
		t.Fatalf("unexpected page %v", got)
	}
	market, archive := page.Items[0], page.Items[1]
	if !market.CanSelect || market.DisabledReason != "" {
		t.Fatalf("upload on 市场部 must be selectable: %+v", market)
	}
	if archive.CanSelect || archive.DisabledReason != disabledReasonUpload {
		t.Fatalf("list-only 归档 must be disabled with a public reason: %+v", archive)
	}

	// The child of 市场部 holds no grant of its own and still inherits upload.
	inherited, err := s.FolderChildren(t.Context(), user, "folder_market", FolderCursor{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(inherited.Items) != 1 || inherited.Items[0].ID != "folder_team" || !inherited.Items[0].CanSelect {
		t.Fatalf("inherited upload must set canSelect: %+v", inherited.Items)
	}

	adminPage, err := s.FolderChildren(t.Context(), adminUser(), "folder_root", FolderCursor{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range adminPage.Items {
		if !item.CanSelect || item.DisabledReason != "" {
			t.Fatalf("admin holds upload everywhere: %+v", item)
		}
	}
}

func TestFolderSearchMatchesVisibleNamesWithVisiblePath(t *testing.T) {
	s, repo := testService(t)
	admin := adminUser()
	seedChild(repo, "folder_rd_a", "研发甲", "folder_market")
	seedChild(repo, "folder_rd_a_child", "甲组", "folder_rd_a")

	page, err := s.SearchFolders(t.Context(), admin, "研发", FolderCursor{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != "folder_rd_a" {
		t.Fatalf("unexpected matches %v", folderIDsOf(page.Items))
	}
	if page.Items[0].Path != "示例科技 / 市场部 / 研发甲" {
		t.Fatalf("path must join the visible ancestors, got %q", page.Items[0].Path)
	}
	if !page.Items[0].HasChildren || !page.Items[0].CanSelect {
		t.Fatalf("unexpected search row %+v", page.Items[0])
	}
	if page.NextCursor != "" {
		t.Fatalf("a complete page must not carry a cursor, got %q", page.NextCursor)
	}
}

func TestFolderSearchTruncatesPathAtHiddenAncestorAndKeepsOrphanARoot(t *testing.T) {
	s, repo := testService(t)
	user := domain.User{ID: "u_user", Login: "user1"}
	seedChild(repo, "folder_rd_a", "研发甲", "folder_market")
	seedChild(repo, "folder_rd_b", "研发乙", "folder_market")
	for _, id := range []string{"folder_rd_a", "folder_rd_b"} {
		repo.seedGrant(domain.ACL{ID: "acl_" + id, FolderID: id, SubjectKind: "user", SubjectID: "u_user",
			Actions: []domain.Action{domain.ActionList}})
	}

	page, err := s.SearchFolders(t.Context(), user, "研", FolderCursor{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("both granted leaves must match, got %v", folderIDsOf(page.Items))
	}
	for _, item := range page.Items {
		if item.Path != item.Name {
			t.Fatalf("path must stop at the hidden ancestor, got %q for %s", item.Path, item.ID)
		}
		if item.CanSelect || item.DisabledReason != disabledReasonUpload {
			t.Fatalf("list-only leaf must not be selectable: %+v", item)
		}
	}

	// The hidden ancestor is invisible by name and by id.
	hidden, err := s.SearchFolders(t.Context(), user, "市场", FolderCursor{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(hidden.Items) != 0 {
		t.Fatalf("a hidden folder name must not match: %v", folderIDsOf(hidden.Items))
	}
	rootMatch, err := s.SearchFolders(t.Context(), user, "示例", FolderCursor{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(rootMatch.Items) != 0 {
		t.Fatalf("a hidden root name must not match: %v", folderIDsOf(rootMatch.Items))
	}

	// Both leaves render as roots of the visible tree.
	roots, err := s.FolderChildren(t.Context(), user, "", FolderCursor{}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(roots.Items) != 2 {
		t.Fatalf("both orphans must surface as roots, got %v", folderIDsOf(roots.Items))
	}
	for _, item := range roots.Items {
		if item.ParentID == nil || *item.ParentID != "folder_market" {
			t.Fatalf("orphan roots keep their real parentId: %+v", item)
		}
	}
}

func TestFolderSearchRejectsBlankQuery(t *testing.T) {
	s, _ := testService(t)
	admin := adminUser()
	for _, query := range []string{"", "   ", "\t\n"} {
		page, err := s.SearchFolders(t.Context(), admin, query, FolderCursor{}, 50)
		if !errors.Is(err, domain.ErrInvalidInput) {
			t.Fatalf("query %q must be invalid, got %v", query, err)
		}
		if len(page.Items) != 0 {
			t.Fatalf("query %q must not return rows", query)
		}
	}
}

func TestFolderSearchPagesEveryMatchExactlyOnce(t *testing.T) {
	s, repo := testService(t)
	admin := adminUser()
	for i := 0; i < 5; i++ {
		seedChild(repo, fmt.Sprintf("folder_report_%d", i), fmt.Sprintf("报告 %d", i), "folder_root")
	}
	seen := map[string]int{}
	cursor := FolderCursor{}
	pages := 0
	for {
		page, err := s.SearchFolders(t.Context(), admin, "报告", cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range page.Items {
			seen[item.ID]++
		}
		pages++
		if page.NextCursor == "" {
			break
		}
		if pages > 10 {
			t.Fatal("cursor must terminate")
		}
		cursor = DecodeFolderCursor(page.NextCursor)
	}
	if len(seen) != 5 || pages != 3 {
		t.Fatalf("paging must cover every match once: %d folders over %d pages", len(seen), pages)
	}
	for id, count := range seen {
		if count != 1 {
			t.Fatalf("%s returned %d times", id, count)
		}
	}
}

func TestFolderReadsWriteNothingAndIgnoreForgedCursors(t *testing.T) {
	s, repo := testService(t)
	admin := adminUser()
	seedChild(repo, "folder_rd", "研发部", "folder_root")
	before := readFootprint(repo)

	first, err := s.FolderChildren(t.Context(), admin, "folder_root", FolderCursor{}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 1 {
		t.Fatalf("the truncated page must hold one row, got %d", len(first.Items))
	}
	if first.NextCursor == "" {
		t.Fatal("a truncated page must carry a cursor")
	}
	// A cursor the server never issued decodes to zero and restarts at page one
	// instead of failing the read.
	forged, err := s.FolderChildren(t.Context(), admin, "folder_root", DecodeFolderCursor("!!!not-a-cursor!!!"), 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(forged.Items) != 1 || forged.Items[0].ID != first.Items[0].ID {
		t.Fatalf("a forged cursor must not change the first page: %v vs %v", folderIDsOf(forged.Items), folderIDsOf(first.Items))
	}
	if _, err = s.SearchFolders(t.Context(), admin, "研发", FolderCursor{}, 50); err != nil {
		t.Fatal(err)
	}
	if after := readFootprint(repo); after != before {
		t.Fatalf("read endpoints must not write: %s -> %s", before, after)
	}
}

func TestFolderCursorRoundTrip(t *testing.T) {
	last := domain.Folder{ID: "folder_market", Name: "市场部"}
	encoded := encodeFolderCursor(last)
	if encoded == "" {
		t.Fatal("cursor must encode")
	}
	decoded := DecodeFolderCursor(encoded)
	if decoded.Name != last.Name || decoded.ID != last.ID {
		t.Fatalf("cursor round trip lost the key: %+v", decoded)
	}
	if DecodeFolderCursor("") != (FolderCursor{}) || DecodeFolderCursor("!!!") != (FolderCursor{}) {
		t.Fatal("an absent or malformed cursor must decode to the zero value")
	}
}
