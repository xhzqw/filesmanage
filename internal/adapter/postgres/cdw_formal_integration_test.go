package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Reuses only the opt-in, named scratch database fixture prepared by G2.
// No production or development database is opened by this test.
func exerciseCDWG7Formal(t *testing.T, ctx context.Context, pool *pgxpool.Pool, repo *Repository,
	service *application.Service, prefix string, admin, alice, bob, charlie domain.User, fileID string) {
	t.Helper()
	root, err := service.CDWCreateRootTask(ctx, admin, application.CDWRootTaskInput{
		Title: "G7 exact frozen formal candidate", FileID: fileID,
		Assignee: ports.CDWAssignmentTarget{Kind: "user", ID: alice.ID},
	}, prefix+"_g7root")
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.CDWAcceptTask(ctx, alice, root.TaskID, 1, prefix+"_g7accept")
	if err != nil {
		t.Fatal(err)
	}
	branch, err := service.CDWCreateBranch(ctx, alice, root.TaskID, prefix+"_g7branch")
	if err != nil {
		t.Fatal(err)
	}
	saveTx, err := repo.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	session, err := saveTx.(ports.CDWBranchStore).CDWOpenBranchSession(ctx, branch.ID, alice.ID,
		application.NewID("cdwos"), application.NewID("cdwkey"), time.Now().Add(30*time.Minute))
	if err != nil {
		_ = saveTx.Rollback(ctx)
		t.Fatal(err)
	}
	if err = saveTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	save, err := service.CDWRequestBranchSave(ctx, alice, branch.ID, session.ID, prefix+"_g7save")
	if err != nil {
		t.Fatal(err)
	}
	sha := strings.Repeat("f", 64)
	blobID := application.NewID("cdwg7blob")
	if _, err = pool.Exec(ctx, `INSERT INTO blobs(id,storage_key,sha256,size_bytes,state)
 VALUES($1,$2,$3,31,'ready')`, blobID, prefix+"_g7-storage", sha); err != nil {
		t.Fatal(err)
	}
	receiptTx, err := repo.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	revisionID := application.NewID("cdwrev")
	applied, err := receiptTx.(ports.CDWBranchStore).CDWCommitBranchCallback(ctx, session.DocumentKey, 6,
		save.ID, sha, blobID, 31, sha, branch.Epoch, revisionID)
	if err != nil || !applied {
		_ = receiptTx.Rollback(ctx)
		t.Fatalf("persist: %v %v", applied, err)
	}
	if err = receiptTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	frozen, err := service.CDWFreezeBranch(ctx, alice, branch.ID, save.ID, revisionID, 2, prefix+"_g7freeze")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.CDWStartFormalApproval(ctx, admin, application.CDWFormalStartInput{
		DeliveryID: frozen.DeliveryID, TemplateVersionID: "missing"}, prefix+"_g7beforeaccept"); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("must reject unreviewed candidate: %v", err)
	}
	gate, err := service.CDWDecideReview(ctx, admin, frozen.ReviewGateID, "accept", "已核对冻结稿", 1, prefix+"_g7gate")
	if err != nil || gate.TaskState != "accepted_delivery" {
		t.Fatalf("gate %v %v", gate, err)
	}
	for i, user := range []domain.User{bob, charlie} {
		role, e := service.CDWGrantFormalApprover(ctx, admin, application.CDWFormalRoleInput{
			UserID: user.ID, FileID: fileID}, prefix+"_g7grant_"+string(rune('A'+i)))
		if e != nil || role.ID == "" {
			t.Fatalf("role %v %v", role, e)
		}
	}
	tpl, err := service.CDWPublishFormalTemplate(ctx, admin, application.CDWFormalTemplateInput{
		TemplateKey: prefix + "_g7_formal_approval",
		Steps: []ports.CDWFormalStepDefinition{
			{NodeKey: "quality", Sequence: 1, ApproverID: bob.ID},
			{NodeKey: "document_control", Sequence: 2, ApproverID: charlie.ID},
		},
	}, prefix+"_g7publish")
	if err != nil {
		t.Fatal(err)
	}
	submit := application.CDWFormalStartInput{DeliveryID: frozen.DeliveryID, TemplateVersionID: tpl.ID}
	started, err := service.CDWStartFormalApproval(ctx, admin, submit, prefix+"_g7start")
	if err != nil || started.SHA256 != sha || started.State != "pending" {
		t.Fatalf("submit %v %v", started, err)
	}
	repeated, err := service.CDWStartFormalApproval(ctx, admin, submit, prefix+"_g7start")
	if err != nil || repeated.ID != started.ID {
		t.Fatalf("submission replay %v %v", repeated, err)
	}
	if _, err = service.CDWStartFormalApproval(ctx, admin, submit, prefix+"_g7start2"); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("duplicate pending instance: %v", err)
	}
	if _, err = service.CDWDecideFormalApproval(ctx, admin, started.ID, application.CDWFormalDecisionInput{Decision: "approve"}, 1,
		prefix+"_g7admin"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("administrator bypassed role: %v", err)
	}
	if _, err = service.CDWDecideFormalApproval(ctx, charlie, started.ID, application.CDWFormalDecisionInput{Decision: "approve"}, 1,
		prefix+"_g7outoforder"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("out-of-order approval allowed: %v", err)
	}
	inbox, err := service.CDWFormalInbox(ctx, bob, 100)
	if err != nil || len(inbox) != 1 || inbox[0].ID != started.ID {
		t.Fatalf("B inbox %v %v", inbox, err)
	}
	first, err := service.CDWDecideFormalApproval(ctx, bob, started.ID, application.CDWFormalDecisionInput{
		Decision: "approve", Reason: "技术确认"}, 1, prefix+"_g7bob")
	if err != nil || first.State != "pending" || first.Revision != 2 {
		t.Fatalf("first approval %v %v", first, err)
	}
	if _, err = service.CDWDecideFormalApproval(ctx, bob, started.ID, application.CDWFormalDecisionInput{Decision: "approve"}, 1,
		prefix+"_g7stale"); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("stale CAS: %v", err)
	}
	detail, err := service.CDWFormalDetail(ctx, charlie, started.ID)
	if err != nil || len(detail.Steps) != 2 || detail.Steps[1].State != "ready" || len(detail.Decisions) != 1 {
		t.Fatalf("timeline %v %v", detail, err)
	}
	final, err := service.CDWDecideFormalApproval(ctx, charlie, started.ID, application.CDWFormalDecisionInput{
		Decision: "approve", Reason: "版本复核"}, 2, prefix+"_g7charlie")
	if err != nil || final.State != "approved" || final.CandidateID == "" {
		t.Fatalf("final approval %v %v", final, err)
	}
	replay, err := service.CDWDecideFormalApproval(ctx, charlie, started.ID, application.CDWFormalDecisionInput{
		Decision: "approve", Reason: "版本复核"}, 2, prefix+"_g7charlie")
	if err != nil || replay.CandidateID != final.CandidateID {
		t.Fatalf("terminal replay %v %v", replay, err)
	}
	var approvedCount, versionSeq int
	if err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM cdw_approved_candidates
 WHERE approval_instance_id=$1 AND content_sha256=$2`, started.ID, sha).Scan(&approvedCount); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, "SELECT current_version_seq FROM files WHERE id=$1", fileID).Scan(&versionSeq); err != nil {
		t.Fatal(err)
	}
	if approvedCount != 1 || versionSeq != 1 {
		t.Fatalf("approved NOT issued/effective: count=%d legacy=%d", approvedCount, versionSeq)
	}
	t.Logf("CDW_G7_FORMAL_POSTGRES_PASS subject=%s candidate=%s sha=%s steps=2", started.SubjectID, final.CandidateID, sha)
}
