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
	if _, err = tx.Exec(ctx, `INSERT INTO folders(id,name,owner_id) VALUES($1,$1,$2)`, folderID, adminID); err != nil {
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
	// Independent branches from the SAME base file cannot change file_versions.
	aliceBranch, err := service.CDWCreateBranch(ctx, alice, root.TaskID)
	if err != nil {
		t.Fatalf("A branch: %v", err)
	}
	bobBranch, err := service.CDWCreateBranch(ctx, bob, child.TaskID)
	if err != nil {
		t.Fatalf("B branch: %v", err)
	}
	if aliceBranch.BaseVersionID != versionID || bobBranch.BaseVersionID != versionID || aliceBranch.ID == bobBranch.ID {
		t.Fatalf("branch baseline mismatch: A=%+v B=%+v", aliceBranch, bobBranch)
	}
	// Simulate a genuinely durable ONLYOFFICE callback through the transaction
	// store; the upstream HTTP downloader uses the same store only AFTER OOXML
	// and signed-callback verification.
	branchCommits := []struct {
		b      ports.CDWBranch
		user   domain.User
		letter string
	}{
		{aliceBranch, alice, "b"}, {bobBranch, bob, "c"},
	}
	var aliceReceipt ports.CDWBranchSave
	var aliceRevision string
	for idx, candidate := range branchCommits {
		workTx, e := repo.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		store := workTx.(ports.CDWBranchStore)
		session, e := store.CDWOpenBranchSession(ctx, candidate.b.ID, candidate.user.ID,
			application.NewID("cdwos"), application.NewID("cdwkey"), time.Now().Add(30*time.Minute))
		if e != nil {
			_ = workTx.Rollback(ctx)
			t.Fatal(e)
		}
		request, e := store.CDWBeginBranchSave(ctx, candidate.b.ID, session.ID, candidate.user.ID, application.NewID("cdwsave"))
		if e != nil {
			_ = workTx.Rollback(ctx)
			t.Fatal(e)
		}
		if e = workTx.Commit(ctx); e != nil {
			t.Fatal(e)
		}
		if idx == 0 {
			aliceReceipt = request
		}
		// A forcesave accepted by ONLYOFFICE is only requested (no revision yet).
		if _, e = service.CDWFreezeBranch(ctx, candidate.user, candidate.b.ID, request.ID, "nonexistent", 1); !errors.Is(e, domain.ErrVersionConflict) {
			t.Fatalf("premature freeze was not blocked: %v", e)
		}
		sha := strings.Repeat(candidate.letter, 64)
		blobID2 := application.NewID("cdwblob")
		if _, e = pool.Exec(ctx, `INSERT INTO blobs(id,storage_key,sha256,size_bytes,state)
		 VALUES($1,$2,$3,29,'ready')`, blobID2, prefix+"_branch_storage_"+candidate.letter, sha); e != nil {
			t.Fatal(e)
		}
		saveTx, e := repo.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		store = saveTx.(ports.CDWBranchStore)
		revisionID := application.NewID("cdwrev")
		applied, e := store.CDWCommitBranchCallback(ctx, session.DocumentKey, 6, request.ID,
			strings.Repeat(candidate.letter, 64), blobID2, 29, sha, candidate.b.Epoch, revisionID)
		if e != nil || !applied {
			_ = saveTx.Rollback(ctx)
			t.Fatalf("callback persist: applied=%v err=%v", applied, e)
		}
		if e = saveTx.Commit(ctx); e != nil {
			t.Fatal(e)
		}
		checkTx, e := repo.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		store = checkTx.(ports.CDWBranchStore)
		receipt, e := store.CDWReadBranchSave(ctx, candidate.b.ID, request.ID, candidate.user.ID)
		_ = checkTx.Rollback(ctx)
		if e != nil || receipt.State != "persisted" || receipt.RevisionID != revisionID || receipt.SHA256 != sha {
			t.Fatalf("saved receipt invalid: %+v %v", receipt, e)
		}
		if idx == 0 {
			aliceRevision = revisionID
		}
		// A callback replay is idempotent; no second branch revision.
		replayTx, e := repo.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		replayed, e := replayTx.(ports.CDWBranchStore).CDWCommitBranchCallback(ctx, session.DocumentKey, 6, request.ID,
			strings.Repeat(candidate.letter, 64), blobID2, 29, sha, candidate.b.Epoch, application.NewID("cdwrev"))
		_ = replayTx.Rollback(ctx)
		if e != nil || replayed {
			t.Fatalf("duplicate callback must not append: %v %v", replayed, e)
		}
	}
	// File's ordinary version history remains pinned to the original upload.
	var fileSeq, versionCount int
	if e := pool.QueryRow(ctx, `SELECT current_version_seq FROM files WHERE id=$1`, fileID).Scan(&fileSeq); e != nil {
		t.Fatal(e)
	}
	if e := pool.QueryRow(ctx, `SELECT count(*) FROM file_versions WHERE file_id=$1`, fileID).Scan(&versionCount); e != nil {
		t.Fatal(e)
	}
	if fileSeq != 1 || versionCount != 1 {
		t.Fatalf("branch changes leaked to formal versions seq=%d count=%d", fileSeq, versionCount)
	}
	// Frozen delivery is tied to a matching persisted save receipt and branch HEAD.
	frozen, e := service.CDWFreezeBranch(ctx, alice, aliceBranch.ID, aliceReceipt.ID, aliceRevision, 2)
	if e != nil {
		t.Fatalf("freeze persisted branch: %v", e)
	}
	if frozen.SHA256 != strings.Repeat("b", 64) || frozen.ReviewGateID == "" {
		t.Fatalf("invalid delivery: %+v", frozen)
	}
	var frozenSHA, reviewer, state string
	if e = pool.QueryRow(ctx, `SELECT i.sha256,g.responsible_user_id,g.state
	 FROM cdw_delivery_items i JOIN cdw_review_gates g ON g.delivery_id=i.delivery_id
	 WHERE i.delivery_id=$1`, frozen.DeliveryID).Scan(&frozenSHA, &reviewer, &state); e != nil {
		t.Fatal(e)
	}
	if frozenSHA != frozen.SHA256 || reviewer != adminID || state != "awaiting" {
		t.Fatalf("review gate mismatch: sha=%s reviewer=%s state=%s", frozenSHA, reviewer, state)
	}
	// Late saving callback cannot change the frozen delivery even with signed
	// document key and a different event hash.
	lateTx, e := repo.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	_, e = lateTx.(ports.CDWBranchStore).CDWCommitBranchCallback(ctx, application.NewID("badkey"), 6, "",
		strings.Repeat("e", 64), blobID, 29, strings.Repeat("a", 64), 1, application.NewID("cdwrev"))
	_ = lateTx.Rollback(ctx)
	if !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("unrecognized doc key was accepted: %v", e)
	}
	if _, e = service.CDWFreezeBranch(ctx, alice, aliceBranch.ID, aliceReceipt.ID, aliceRevision, 2); !errors.Is(e, domain.ErrVersionConflict) {
		t.Fatalf("duplicate delivery freeze accepted: %v", e)
	}
	t.Logf("CDW_BRANCH_POSTGRES_PASS branches=%s,%s persisted=2 froze=%s normal_seq=1", aliceBranch.ID, bobBranch.ID, frozen.DeliveryID)
	var n int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM cdw_domain_events WHERE aggregate_id IN ($1,$2,$3,$4)`,
		root.TaskID, child.TaskID, child2.TaskID, groupRoot.TaskID).Scan(&n); err != nil || n != 7 {
		t.Fatalf("atomic CDW event count=%d err=%v", n, err)
	}
	t.Logf("CDW_TASK_POSTGRES_PASS root=%s child=%s grandchild=%s pending-obligations=6", root.TaskID, child.TaskID, child2.TaskID)
}
