package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5/pgxpool"
	"strings"
	"testing"
	"time"
)

// Uses genuinely persisted branch callbacks, frozen deliveries and review
// decisions; no manual changes to task states or synthetic approval evidence.
func exerciseCDWG11Obligations(t *testing.T, ctx context.Context, pool *pgxpool.Pool, repo *Repository,
	svc *application.Service, prefix string, admin, alice, bob, charlie domain.User,
	root, child, grandchild ports.CDWTaskResult, bobBranch ports.CDWBranch, bobReceipt ports.CDWBranchSave,
	bobRevision, fileID, baseBlobID string) {
	t.Helper()
	var managedID, managedRev string
	var pendingRevision int64
	if err := pool.QueryRow(ctx, `SELECT id,revision FROM cdw_accountability_obligations
 WHERE task_id=$1 AND obligation_kind='manage'`, child.TaskID).Scan(&managedID, &pendingRevision); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CDWCompleteObligation(ctx, alice, managedID,
		application.CDWObligationCompleteInput{Statement: "已收到派发但尚未完成子任务，不得提早履行"},
		pendingRevision, prefix+"_g11_early"); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("unaccepted subordinate cannot silently satisfy management: %v", err)
	}
	if _, err := svc.CDWCompleteObligation(ctx, charlie, managedID,
		application.CDWObligationCompleteInput{Statement: "越级人员不能替代责任人自动核销责任"},
		pendingRevision, prefix+"_g11_unrelated"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("unrelated person discharged intermediate duty: %v", err)
	}

	cBranch, err := svc.CDWCreateBranch(ctx, charlie, grandchild.TaskID, prefix+"_g11_cbranch")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := repo.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	session, err := tx.(ports.CDWBranchStore).CDWOpenBranchSession(ctx, cBranch.ID, charlie.ID,
		application.NewID("cdwos"), application.NewID("cdwkey"), time.Now().Add(30*time.Minute))
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	request, err := svc.CDWRequestBranchSave(ctx, charlie, cBranch.ID, session.ID, prefix+"_g11_csave")
	if err != nil {
		t.Fatal(err)
	}
	sourceHash := strings.Repeat("e", 64)
	blobID := application.NewID("cdwg11blob")
	if _, err = pool.Exec(ctx, `INSERT INTO blobs(id,storage_key,sha256,size_bytes,state)
 VALUES($1,$2,$3,42,'ready')`, blobID, prefix+"_g11_blob", sourceHash); err != nil {
		t.Fatal(err)
	}
	persistedRevision := application.NewID("cdwrev")
	tx, err = repo.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	applied, err := tx.(ports.CDWBranchStore).CDWCommitBranchCallback(ctx, session.DocumentKey, 6,
		request.ID, sourceHash, blobID, 42, sourceHash, cBranch.Epoch, persistedRevision)
	if err != nil || !applied {
		_ = tx.Rollback(ctx)
		t.Fatalf("persist subordinate: %v %v", applied, err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	frozenC, err := svc.CDWFreezeBranch(ctx, charlie, cBranch.ID, request.ID, persistedRevision, 2, prefix+"_g11_cfreeze")
	if err != nil {
		t.Fatal(err)
	}
	acceptedC, err := svc.CDWDecideReview(ctx, bob, frozenC.ReviewGateID, "accept", "C级真实保存和冻结稿验收", 1, prefix+"_g11_caccept")
	if err != nil || acceptedC.TaskState != "accepted_delivery" {
		t.Fatalf("C review: %+v %v", acceptedC, err)
	}
	frozenB, err := svc.CDWFreezeBranch(ctx, bob, bobBranch.ID, bobReceipt.ID, bobRevision, 2, prefix+"_g11_bfreeze")
	if err != nil {
		t.Fatalf("B freeze after C review: %v", err)
	}
	acceptedB, err := svc.CDWDecideReview(ctx, alice, frozenB.ReviewGateID, "accept", "B级实际整合结果验收", 1, prefix+"_g11_baccept")
	if err != nil || acceptedB.TaskState != "accepted_delivery" {
		t.Fatalf("B review: %+v %v", acceptedB, err)
	}
	// B's integrated work now exists, but none of the six duties should have
	// changed merely because the two review gates were accepted.
	var pending int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM cdw_accountability_obligations
 WHERE task_id IN($1,$2) AND state='pending'`, child.TaskID, grandchild.TaskID).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 6 {
		t.Fatalf("intermediate duties auto-closed: %d", pending)
	}
	kinds := []string{"manage", "integrate", "report"}
	fulfill := func(actor domain.User, taskID, kind string) {
		t.Helper()
		var id string
		var revision int64
		err := pool.QueryRow(ctx, `SELECT id,revision FROM cdw_accountability_obligations
   WHERE task_id=$1 AND responsible_user_id=$2 AND obligation_kind=$3`, taskID, actor.ID, kind).Scan(&id, &revision)
		if err != nil {
			t.Fatal(err)
		}
		input := application.CDWObligationCompleteInput{Statement: "经现场核查已履行独立的" + kind + "职责并记录签收、整合及报告依据"}
		key := prefix + "_g11_" + kind + "_" + actor.ID
		receipt, err := svc.CDWCompleteObligation(ctx, actor, id, input, revision, key)
		if err != nil || receipt.State != "fulfilled" || len(receipt.EvidenceSHA256) != 64 {
			t.Fatalf("obligation %s: %+v %v", kind, receipt, err)
		}
		replay, err := svc.CDWCompleteObligation(ctx, actor, id, input, revision, key)
		if err != nil || replay.EvidenceSHA256 != receipt.EvidenceSHA256 {
			t.Fatalf("replay %v %v", replay, err)
		}
		if _, err = svc.CDWCompleteObligation(ctx, actor, id, input, revision, key+"_stale"); !errors.Is(err, domain.ErrVersionConflict) {
			t.Fatalf("stale obligation CAS: %v", err)
		}
	}
	// The dependency graph means one must explicitly manage before integrating,
	// and integrate before reporting.
	var reportID string
	err = pool.QueryRow(ctx, `SELECT id FROM cdw_accountability_obligations
 WHERE task_id=$1 AND obligation_kind='report'`, child.TaskID).Scan(&reportID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = svc.CDWCompleteObligation(ctx, alice, reportID,
		application.CDWObligationCompleteInput{Statement: "未经独立管理整合不能直接履行上报责任"}, 1,
		prefix+"_g11_report_early"); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("report bypassed preceding obligations: %v", err)
	}
	_ = managedRev
	for _, kind := range kinds {
		fulfill(bob, grandchild.TaskID, kind)
	}
	for _, kind := range kinds {
		fulfill(alice, child.TaskID, kind)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM cdw_accountability_obligations
 WHERE task_id IN($1,$2) AND state='pending'`, child.TaskID, grandchild.TaskID).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 0 {
		t.Fatalf("evidenced responsibilities still pending=%d", pending)
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM cdw_obligation_fulfillments
 WHERE task_id IN($1,$2)`, child.TaskID, grandchild.TaskID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 6 {
		t.Fatalf("missing immutable evidence %d", count)
	}
	t.Logf("CDW_G11_ACCOUNTABILITY_POSTGRES_PASS chain=%s/%s/%s facts=6 remaining=0",
		root.TaskID, child.TaskID, grandchild.TaskID)
}
