package application

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"filesmanage/internal/domain"
	"golang.org/x/crypto/bcrypt"
)

// TestExportStreamsAuthorizedRows locks the SPEC §3.10 export contract: every
// filtered row is streamed (no 200-row clamp), the seven columns are present,
// formula-looking names are neutralised, and versions reflect the current seq.
func TestExportStreamsAuthorizedRows(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	names := []string{"预算.txt", "=cmd|' /C calc'!A0.txt", "no-extension"}
	for _, name := range names {
		if _, err := s.CommitUpload(ctx, admin, "folder_market", name, "text/plain", "", strings.NewReader(name)); err != nil {
			t.Fatal(err)
		}
	}
	var got [][]string
	n, err := s.ExportCSVStream(ctx, admin, SearchFilter{FolderID: "folder_market"}, func(fields []string) error {
		got = append(got, fields)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if n != len(names) || len(got) != len(names) {
		t.Fatalf("stream must yield every filtered row: count=%d rows=%d", n, len(got))
	}
	neutralised := false
	for _, fields := range got {
		if len(fields) != 7 {
			t.Fatalf("export row must carry the seven SPEC §3.10 columns, got %d", len(fields))
		}
		if fields[6] != "1" {
			t.Fatalf("uploaded file must export version 1, got %q", fields[6])
		}
		if fields[0] == "预算.txt" && fields[5] != ".txt" {
			t.Fatalf("extension column must report the lowercase suffix, got %q", fields[5])
		}
		if strings.HasPrefix(fields[0], "'=cmd") {
			neutralised = true
		}
	}
	if !neutralised {
		t.Fatal("formula-looking file name must be neutralised in the CSV stream")
	}
	// The success path audits the export with its row count.
	repo.mu.Lock()
	defer repo.mu.Unlock()
	audited := false
	for _, e := range repo.audit {
		if e.EventType == "files.export" && e.Outcome == "success" {
			audited = true
		}
	}
	if !audited {
		t.Fatal("a successful export must be audited")
	}
}

// TestExportStreamStopsWhenConsumerFails covers a client disconnect: the
// stream aborts instead of scanning the whole table for a dead connection.
func TestExportStreamStopsWhenConsumerFails(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	ctx := context.Background()
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		if _, err := s.CommitUpload(ctx, admin, "folder_market", name, "text/plain", "", strings.NewReader(name)); err != nil {
			t.Fatal(err)
		}
	}
	seen := 0
	_, err := s.ExportCSVStream(ctx, admin, SearchFilter{FolderID: "folder_market"}, func([]string) error {
		seen++
		return errors.New("client gone")
	})
	if err == nil {
		t.Fatal("consumer failure must abort the export")
	}
	if seen != 1 {
		t.Fatalf("export must stop at the first failed write, saw %d rows", seen)
	}
}

// TestRecordExportFailureAuditsStreamBreak ensures a broken stream is visible
// in the audit trail: the status line is already committed at that point.
func TestRecordExportFailureAuditsStreamBreak(t *testing.T) {
	s, repo := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	s.RecordExportFailure(context.Background(), admin, 12, errors.New("connection reset by peer"))
	repo.mu.Lock()
	defer repo.mu.Unlock()
	found := false
	for _, e := range repo.audit {
		if e.EventType == "files.export" && e.Outcome == "failed" {
			found = true
			if rows, ok := e.Details["rows"]; !ok || rows != 12 {
				t.Fatalf("failure audit must carry the streamed row count, got %v", e.Details["rows"])
			}
		}
	}
	if !found {
		t.Fatal("a broken export stream must be audited as failed")
	}
}

// TestFolderShareUsesOnePermissionPath locks SPEC §2.4: a folder share must
// grant list/preview on the shared folder and, with include_descendants, on
// its subtree — through the same resolution the document page uses, not only
// the search scope. Revocation takes effect on the next request.
func TestFolderShareUsesOnePermissionPath(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	member := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()

	sharedParent, err := s.CreateFolder(ctx, admin, "folder_market", "共享父目录")
	if err != nil {
		t.Fatal(err)
	}
	sharedChild, err := s.CreateFolder(ctx, admin, sharedParent.ID, "共享子目录")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.CommitUpload(ctx, admin, sharedChild.ID, "share.txt", "text/plain", "", strings.NewReader("shared")); err != nil {
		t.Fatal(err)
	}
	// A second subtree shared WITHOUT descendants.
	closedParent, err := s.CreateFolder(ctx, admin, "folder_market", "不蔓延父目录")
	if err != nil {
		t.Fatal(err)
	}
	closedChild, err := s.CreateFolder(ctx, admin, closedParent.ID, "不蔓延子目录")
	if err != nil {
		t.Fatal(err)
	}

	if _, err = s.CreateShare(ctx, admin, ShareDraft{
		ResourceKind: "folder", ResourceID: sharedParent.ID,
		RecipientKind: "user", RecipientID: member.ID,
		Actions: []domain.Action{domain.ActionList, domain.ActionPreview}, IncludeDescendants: true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateShare(ctx, admin, ShareDraft{
		ResourceKind: "folder", ResourceID: closedParent.ID,
		RecipientKind: "user", RecipientID: member.ID,
		Actions: []domain.Action{domain.ActionList, domain.ActionPreview}, IncludeDescendants: false,
	}); err != nil {
		t.Fatal(err)
	}

	page, err := s.ListFiles(ctx, member, sharedChild.ID, "", FileCursor{}, 50)
	if err != nil {
		t.Fatalf("descendant of a shared folder must be listable: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("shared child folder must expose its file, got %d rows", len(page.Items))
	}
	// Without include_descendants the child stays closed.
	if _, err = s.ListFiles(ctx, member, closedChild.ID, "", FileCursor{}, 50); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("child of a non-inheriting share must stay forbidden, got %v", err)
	}

	shares, err := s.ListShares(ctx, admin, "sent")
	if err != nil || len(shares) != 2 {
		t.Fatalf("expected two sent shares, got %d (%v)", len(shares), err)
	}
	for _, share := range shares {
		if err = s.RevokeShare(ctx, admin, share.ID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = s.ListFiles(ctx, member, sharedChild.ID, "", FileCursor{}, 50); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("revoked share must deny the child folder immediately, got %v", err)
	}
}

// TestFileShareGrantsPreviewOutsideFolderScope covers the directly shared file
// that lives in a folder the recipient cannot list (SPEC §2.4).
func TestFileShareGrantsPreviewOutsideFolderScope(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	member := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()
	uploaded, err := s.CommitUpload(ctx, admin, "folder_market", "shared.bin", "application/octet-stream", "", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Preview(ctx, member, uploaded.FileID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("unshared file must stay forbidden, got %v", err)
	}
	fileID := uploaded.FileID
	if _, err = s.CreateShare(ctx, admin, ShareDraft{
		ResourceKind: "file", ResourceID: fileID,
		RecipientKind: "user", RecipientID: member.ID,
		Actions: []domain.Action{domain.ActionPreview, domain.ActionDownload},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Preview(ctx, member, uploaded.FileID); err != nil {
		t.Fatalf("file share must grant preview: %v", err)
	}
}

// TestStatsCacheMemoisesPerPrincipal pins the dashboard cache contract: within
// the TTL the same principal+scope is served from the cache (the aggregation
// does not re-run), the TTL bounds staleness, and a different filter is a
// different entry. Value-level ACL isolation is the PostgreSQL scope CTE's
// job and is asserted end-to-end by scripts/m7_security_e2e.py; here the
// cache key itself is asserted to carry the principal and the whole filter.
func TestStatsCacheMemoisesPerPrincipal(t *testing.T) {
	clock := time.Date(2026, 10, 8, 13, 0, 0, 0, time.UTC)
	repo := newMemoryRepo()
	hash, err := bcrypt.GenerateFromPassword([]byte("long-unit-test-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	repo.seedUser(domain.User{ID: "u_admin", Login: "admin", DisplayName: "系统管理员", IsAdmin: true}, string(hash))
	repo.seedUser(domain.User{ID: "u_user", Login: "user1", DisplayName: "普通用户"}, string(hash))
	repo.seedFolder(domain.Folder{ID: "folder_root", Name: "中晟生物科技", OwnerID: "u_admin"})
	repo.seedFolder(domain.Folder{ID: "folder_market", Name: "市场部", ParentID: strPtr("folder_root"), OwnerID: "u_admin"})
	s := New(repo, newMemoryBlob()).WithClock(func() time.Time { return clock })
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	other := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()

	for _, name := range []string{"a.txt", "b.txt"} {
		if _, err := s.CommitUpload(ctx, admin, "folder_market", name, "text/plain", "", strings.NewReader(name)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.CommitUpload(ctx, admin, "folder_root", "c.txt", "text/plain", "", strings.NewReader("c")); err != nil {
		t.Fatal(err)
	}

	// Within the TTL the cached aggregation is returned even though the ground
	// truth moved: that is the cache doing its job (and why the TTL exists).
	first, err := s.Stats(ctx, admin, SearchFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if first.TotalFiles != 3 {
		t.Fatalf("baseline total = %d, want 3", first.TotalFiles)
	}
	if _, err := s.CommitUpload(ctx, admin, "folder_root", "d.txt", "text/plain", "", strings.NewReader("d")); err != nil {
		t.Fatal(err)
	}
	cached, err := s.Stats(ctx, admin, SearchFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if cached.TotalFiles != 3 {
		t.Fatalf("within the TTL the cached aggregation must be returned: got %d, want 3", cached.TotalFiles)
	}

	// A different filter is a different entry and is computed fresh.
	scoped, err := s.Stats(ctx, admin, SearchFilter{FolderID: "folder_market"})
	if err != nil {
		t.Fatal(err)
	}
	if scoped.TotalFiles != 2 {
		t.Fatalf("folder-scoped entry = %d, want 2", scoped.TotalFiles)
	}

	// Past the TTL the aggregation re-runs and sees the new file.
	clock = clock.Add(31 * time.Second)
	fresh, err := s.Stats(ctx, admin, SearchFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if fresh.TotalFiles != 4 {
		t.Fatalf("after the TTL the aggregation must re-run: got %d, want 4", fresh.TotalFiles)
	}

	// The cache key carries the principal and the whole filter, so one user's
	// aggregation can never be served to another user or another scope.
	base := statsCacheKey(admin, SearchFilter{})
	if key := statsCacheKey(other, SearchFilter{}); key == base {
		t.Fatal("the cache key must carry the principal")
	}
	if key := statsCacheKey(admin, SearchFilter{FolderID: "folder_market"}); key == base {
		t.Fatal("the cache key must carry the filter")
	}
	if key := statsCacheKey(admin, SearchFilter{IncludeDescendant: true}); key == base {
		t.Fatal("the cache key must carry the descendant flag")
	}
}

// TestShareRecipientsAreMinimalAndRoleIndependent pins WF-21: the share wizard
// needs a recipient picker any authenticated caller may use, but it must stay a
// minimal read — id plus display label only, disabled accounts excluded,
// matches capped, unknown kinds rejected — never the admin user directory.
func TestShareRecipientsAreMinimalAndRoleIndependent(t *testing.T) {
	s, _ := testService(t)
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	member := domain.User{ID: "u_user", Login: "user1"}
	ctx := context.Background()
	clerk, err := s.CreateUser(ctx, admin, UserDraft{Login: "clerk01", DisplayName: "市场部文员", Password: "initial-credential-0001"})
	if err != nil {
		t.Fatal(err)
	}
	alice, err := s.CreateUser(ctx, admin, UserDraft{Login: "clerk02", DisplayName: "Alice Chen", Password: "initial-credential-0002"})
	if err != nil {
		t.Fatal(err)
	}
	suspended, err := s.CreateUser(ctx, admin, UserDraft{Login: "clerk03", DisplayName: "暂停账号", Password: "initial-credential-0003"})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetUserDisabled(ctx, admin, suspended.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateWorkgroup(ctx, admin, "市场工作组", ""); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateWorkgroup(ctx, admin, "研发组", ""); err != nil {
		t.Fatal(err)
	}

	// A non-admin and an admin observe exactly the same minimal user rows: the
	// endpoint is role-independent by design, and ShareRecipient carries no
	// field beyond id and the display label to leak.
	var memberRows, adminRows map[string]string
	for i, caller := range []domain.User{member, admin} {
		page, err := s.ShareRecipients(ctx, caller, "user", "", 50)
		if err != nil {
			t.Fatalf("caller %s: %v", caller.ID, err)
		}
		if page.Truncated {
			t.Fatalf("caller %s: %d matches fit the default cap", caller.ID, len(page.Items))
		}
		rows := map[string]string{}
		for _, row := range page.Items {
			if row.ID == "" || row.Name == "" {
				t.Fatalf("caller %s: a recipient row must carry an id and a display label: %+v", caller.ID, row)
			}
			rows[row.ID] = row.Name
		}
		// The two fixture accounts plus 文员 and Alice are active; the disabled
		// account is not offered.
		if len(rows) != 4 {
			t.Fatalf("caller %s: got %d active users, want 4", caller.ID, len(rows))
		}
		if _, disabled := rows[suspended.ID]; disabled {
			t.Fatal("a disabled account must not be offered as a share recipient")
		}
		if rows[clerk.ID] != "市场部文员" {
			t.Fatalf("user row label = %q, want the display name", rows[clerk.ID])
		}
		if i == 0 {
			memberRows = rows
		} else {
			adminRows = rows
		}
	}
	if len(memberRows) != len(adminRows) {
		t.Fatal("admin and non-admin must see the same recipient set")
	}
	for id, name := range memberRows {
		if adminRows[id] != name {
			t.Fatalf("admin and non-admin rows differ for %s", id)
		}
	}

	// The q filter matches the display name case-insensitively.
	filtered, err := s.ShareRecipients(ctx, member, "user", "市场", 50)
	if err != nil || len(filtered.Items) != 1 || filtered.Items[0].ID != clerk.ID {
		t.Fatalf("q must filter the display name: %v %+v", err, filtered.Items)
	}
	upper, err := s.ShareRecipients(ctx, member, "user", "ALICE", 50)
	if err != nil || len(upper.Items) != 1 || upper.Items[0].ID != alice.ID {
		t.Fatalf("q must match case-insensitively: %v %+v", err, upper.Items)
	}
	if none, err := s.ShareRecipients(ctx, member, "user", "查无此人", 50); err != nil || len(none.Items) != 0 {
		t.Fatalf("a non-matching q must return no rows: %v %+v", err, none.Items)
	}

	// Groups come back with id + name; the q filter applies there too.
	groups, err := s.ShareRecipients(ctx, member, "group", "", 50)
	if err != nil || len(groups.Items) != 2 || groups.Truncated {
		t.Fatalf("group recipients wrong: %v %+v", err, groups)
	}
	for _, row := range groups.Items {
		if row.ID == "" || row.Name == "" {
			t.Fatalf("group row must carry id and name: %+v", row)
		}
	}
	groupMatch, err := s.ShareRecipients(ctx, member, "group", "研发", 50)
	if err != nil || len(groupMatch.Items) != 1 || groupMatch.Items[0].Name != "研发组" {
		t.Fatalf("q must filter group names: %v %+v", err, groupMatch.Items)
	}

	// The cap holds and flags the truncation without disclosing the count.
	capped, err := s.ShareRecipients(ctx, member, "user", "", 2)
	if err != nil || len(capped.Items) != 2 || !capped.Truncated {
		t.Fatalf("the cap must cut the list and flag the truncation: %v %+v", err, capped)
	}
	// A limit over the cap is clamped, not rejected.
	clamped, err := s.ShareRecipients(ctx, member, "user", "", 5000)
	if err != nil || len(clamped.Items) != 4 || clamped.Truncated {
		t.Fatalf("an over-cap limit must clamp and still return every match: %v %+v", err, clamped)
	}

	// Unknown kinds and empty kinds are rejected outright.
	for _, kind := range []string{"", "dept", "USER"} {
		if _, err := s.ShareRecipients(ctx, member, kind, "", 50); !errors.Is(err, domain.ErrInvalidInput) {
			t.Fatalf("kind %q must be rejected, got %v", kind, err)
		}
	}
}

func strPtr(v string) *string { return &v }
