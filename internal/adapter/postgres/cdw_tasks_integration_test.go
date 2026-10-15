package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const cdwTaskScratchName = "cdw_g2_tasks_iso_20261015"

// Never run against a production or development database. This integration
// suite is opt-in and checks current_database before creating any fixture.
func TestCDWTaskPostgresTransactions(t *testing.T) {
	dsn := os.Getenv("CDW_TASK_TEST_DSN")
	if dsn == "" {
		t.Skip("set CDW_TASK_TEST_DSN for an isolated PostgreSQL 17 database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var dbName string
	if err = pool.QueryRow(ctx, "SELECT current_database()").Scan(&dbName); err != nil {
		t.Fatal(err)
	}
	if dbName != cdwTaskScratchName {
		t.Fatalf("refusing to mutate non-isolated database %q", dbName)
	}
	repo := New(pool)
	service := application.New(repo, nil)
	prefix := application.NewID("g2")
	adminID, aliceID, bobID, charlieID := prefix+"_admin", prefix+"_alice", prefix+"_bob", prefix+"_charlie"
	folderID, fileID, blobID, versionID := prefix+"_folder", prefix+"_file", prefix+"_blob", prefix+"_version"
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	for _, id := range []string{adminID, aliceID, bobID, charlieID} {
		admin := id == adminID
		if _, err = tx.Exec(ctx, `INSERT INTO users(id,login,display_name,password_hash,is_admin,must_change_password)
  VALUES($1,$1,$1,'fixture-no-login',$2,false)`, id, admin); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO folders(id,name,owner_id) VALUES($1,'G2 isolated fixture',$2)`, folderID, adminID); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{aliceID, bobID, charlieID} {
		if _, err = tx.Exec(ctx, `INSERT INTO acls(id,folder_id,subject_kind,subject_id,actions,granted_by)
   VALUES($1,$2,'user',$3,ARRAY['list','preview']::text[],$4)`, application.NewID("g2acl"), folderID, id, adminID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO files(id,folder_id,name,uploaded_by)
 VALUES($1,$2,'G2 document.docx',$3)`, fileID, folderID, adminID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO blobs(id,storage_key,sha256,size_bytes,state)
 VALUES($1,$2,$3,42,'ready')`, blobID, prefix+"_storage", strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO file_versions(id,file_id,seq,blob_id,size_bytes,sha256,action,created_by)
 VALUES($1,$2,1,$3,42,$4,'upload',$5)`, versionID, fileID, blobID, strings.Repeat("a", 64), adminID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE files SET current_version_seq=1 WHERE id=$1`, fileID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	admin := domain.User{ID: adminID, IsAdmin: true}
	alice := domain.User{ID: aliceID}
	bob := domain.User{ID: bobID}
	charlie := domain.User{ID: charlieID}
	rootInput := application.CDWRootTaskInput{Title: "G2 A task", FileID: fileID, Assignee: ports.CDWAssignmentTarget{Kind: "user", ID: aliceID}}
	root, err := service.CDWCreateRootTask(ctx, admin, rootInput, prefix+"_create_root")
	if err != nil {
		t.Fatal("create root:", err)
	}
	if root.Revision != 1 || root.State != "assigned" {
		t.Fatalf("root: %+v", root)
	}
	replay, err := service.CDWCreateRootTask(ctx, admin, rootInput, prefix+"_create_root")
	if err != nil || replay.TaskID != root.TaskID {
		t.Fatalf("same key replay: %+v %v", replay, err)
	}
	altered := rootInput
	altered.Title = "unauthorized different request"
	if _, err = service.CDWCreateRootTask(ctx, admin, altered, prefix+"_create_root"); !errors.Is(err, ports.ErrCDWIdempotencyReuse) {
		t.Fatalf("changed request must 409 idempotency reuse; got %v", err)
	}
	if _, err = service.CDWAcceptTask(ctx, bob, root.TaskID, 1, prefix+"_wrong_accept"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non assignee accepted: %v", err)
	}
	accepted, err := service.CDWAcceptTask(ctx, alice, root.TaskID, 1, prefix+"_alice_accept")
	if err != nil || accepted.State != "accepted" || accepted.AcceptedBy != aliceID || accepted.Revision != 2 {
		t.Fatalf("alice accept: %+v %v", accepted, err)
	}
	if _, err = service.CDWAcceptTask(ctx, alice, root.TaskID, 1, prefix+"_stale_accept"); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("stale accept must conflict: %v", err)
	}
	childInput := application.CDWChildTaskInput{Title: "G2 B child", Assignee: ports.CDWAssignmentTarget{Kind: "user", ID: bobID}}
	child, err := service.CDWDelegateTask(ctx, alice, root.TaskID, childInput, 2, prefix+"_alice_delegate")
	if err != nil {
		t.Fatal("delegate:", err)
	}
	if child.ParentTaskID != root.TaskID || child.ParentRevision != 3 || len(child.RemainingObligations) != 3 {
		t.Fatalf("parent accountability missing: %+v", child)
	}
	var pending int
	err = pool.QueryRow(ctx, `SELECT count(*) FROM cdw_accountability_obligations
 WHERE task_id=$1 AND responsible_user_id=$2 AND state='pending'`, child.TaskID, aliceID).Scan(&pending)
	if err != nil || pending != 3 {
		t.Fatalf("A obligation count=%d err=%v", pending, err)
	}
	bobAccepted, err := service.CDWAcceptTask(ctx, bob, child.TaskID, 1, prefix+"_bob_accept")
	if err != nil || bobAccepted.AcceptedBy != bobID {
		t.Fatalf("B accept: %+v %v", bobAccepted, err)
	}
	child2, err := service.CDWDelegateTask(ctx, bob, child.TaskID,
		application.CDWChildTaskInput{Title: "G2 C child", Assignee: ports.CDWAssignmentTarget{Kind: "user", ID: charlieID}},
		2, prefix+"_bob_delegate")
	if err != nil {
		t.Fatal("delegate C:", err)
	}
	if len(child2.RemainingObligations) != 3 {
		t.Fatalf("B obligations missing: %+v", child2)
	}
	err = pool.QueryRow(ctx, `SELECT count(*) FROM cdw_accountability_obligations
 WHERE task_id IN ($1,$2) AND state='pending'`, child.TaskID, child2.TaskID).Scan(&pending)
	if err != nil || pending != 6 {
		t.Fatalf("A/B pending obligations lost: %d %v", pending, err)
	}
	// Independent keys racing to accept C: a single winner and one conflict.
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = service.CDWAcceptTask(ctx, charlie, child2.TaskID, 1, prefix+"_charlie_accept_"+string(rune('A'+i)))
		}(i)
	}
	wg.Wait()
	won, conflict := 0, 0
	for _, e := range errs {
		if e == nil {
			won++
		} else if errors.Is(e, domain.ErrVersionConflict) {
			conflict++
		} else {
			t.Fatalf("unexpected accept error: %v", e)
		}
	}
	if won != 1 || conflict != 1 {
		t.Fatalf("concurrent accept won=%d conflict=%d", won, conflict)
	}
	items, err := service.CDWTaskInbox(ctx, alice, 30)
	if err != nil {
		t.Fatal(err)
	}
	obligationRows := 0
	for _, item := range items {
		if item.Kind == "obligation" && item.TaskID == child.TaskID {
			obligationRows++
		}
	}
	if obligationRows != 3 {
		t.Fatalf("A inbox obligations=%d; want 3", obligationRows)
	}

	// Revoked group appointments must never give an old pending assignment
	// the power to accept on behalf of a workgroup.
	groupID := prefix + "_group"
	grantID := prefix + "_role"
	if _, err = pool.Exec(ctx, `INSERT INTO workgroups(id,name) VALUES($1,'G2 team')`, groupID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO cdw_workgroup_role_bindings
 (id,group_id,user_id,role,granted_by) VALUES($1,$2,$3,'leader',$4)`, grantID, groupID, charlieID, adminID); err != nil {
		t.Fatal(err)
	}
	groupRoot, err := service.CDWCreateRootTask(ctx, admin, application.CDWRootTaskInput{
		Title: "G2 group root", FileID: fileID, Assignee: ports.CDWAssignmentTarget{Kind: "workgroup", ID: groupID},
	}, prefix+"_group_create")
	if err != nil {
		t.Fatal("group task:", err)
	}
	if _, err = service.CDWAcceptTask(ctx, bob, groupRoot.TaskID, 1, prefix+"_group_notleader"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("ordinary group member or outsider must not accept: %v", err)
	}
	if _, err = pool.Exec(ctx, `UPDATE cdw_workgroup_role_bindings SET revoked_at=now() WHERE id=$1`, grantID); err != nil {
		t.Fatal(err)
	}
	if _, err = service.CDWAcceptTask(ctx, charlie, groupRoot.TaskID, 1, prefix+"_group_revoked"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("revoked leader must not accept: %v", err)
	}
	var n int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM cdw_domain_events WHERE aggregate_id IN ($1,$2,$3,$4)`,
		root.TaskID, child.TaskID, child2.TaskID, groupRoot.TaskID).Scan(&n); err != nil || n != 7 {
		t.Fatalf("atomic CDW event count=%d err=%v", n, err)
	}
	t.Logf("CDW_TASK_POSTGRES_PASS root=%s child=%s grandchild=%s pending-obligations=6", root.TaskID, child.TaskID, child2.TaskID)
}
