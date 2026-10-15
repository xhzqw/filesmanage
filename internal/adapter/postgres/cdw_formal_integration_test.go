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

	// G8: neither acceptance nor formal approval permits an uncontrolled issue.
	if _, e := service.CDWControlPrepare(ctx, admin, application.CDWControlPrepareInput{
		CandidateID: final.CandidateID, RevisionLabel: "A/0"}, prefix+"_g8_without_role"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("admin must not automatically become document-control officer: %v", e)
	}
	grants, e := service.CDWControlGrantRole(ctx, admin, application.CDWControlRoleInput{
		UserID: admin.ID, FileID: fileID}, prefix+"_g8_role")
	if e != nil || grants.ID == "" {
		t.Fatalf("control-role grant: %+v %v", grants, e)
	}
	candidates, e := service.CDWControlCandidates(ctx, admin, 100)
	if e != nil {
		t.Fatalf("candidate listing: %v", e)
	}
	found := false
	for _, row := range candidates {
		if row.ID == final.CandidateID && row.SHA256 == sha {
			found = true
		}
	}
	if !found {
		t.Fatalf("approved frozen candidate not available: %+v", candidates)
	}
	prepareInput := application.CDWControlPrepareInput{CandidateID: final.CandidateID, RevisionLabel: "A/0"}
	prepared, e := service.CDWControlPrepare(ctx, admin, prepareInput, prefix+"_g8_prepare")
	if e != nil || prepared.State != "preparing" || prepared.SHA256 != sha {
		t.Fatalf("controlled release preparation: %+v %v", prepared, e)
	}
	again, e := service.CDWControlPrepare(ctx, admin, prepareInput, prefix+"_g8_prepare")
	if e != nil || again.ID != prepared.ID {
		t.Fatalf("release preparation idempotency: %+v %v", again, e)
	}
	if _, e = service.CDWControlPrepare(ctx, admin, prepareInput, prefix+"_g8_duplicate"); !errors.Is(e, domain.ErrConflict) {
		t.Fatalf("duplicate candidate must be rejected: %v", e)
	}
	rows, e := service.CDWControlList(ctx, admin, fileID)
	if e != nil || len(rows) != 1 || rows[0].ID != prepared.ID {
		t.Fatalf("release listing: %+v %v", rows, e)
	}
	var sourceArtifactCount, pointerCount int
	if e = pool.QueryRow(ctx, `SELECT count(*) FROM cdw_release_artifacts WHERE release_id=$1
 AND purpose='source' AND sha256=$2`, prepared.ID, sha).Scan(&sourceArtifactCount); e != nil {
		t.Fatal(e)
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM cdw_effective_pointers WHERE file_id=$1", fileID).Scan(&pointerCount); e != nil {
		t.Fatal(e)
	}
	if sourceArtifactCount != 1 || pointerCount != 0 {
		t.Fatalf("preparation leaked into effective version: artifacts=%d pointer=%d", sourceArtifactCount, pointerCount)
	}
	verifyInput := application.CDWControlVerificationInput{
		Justification:            "经文控核验，本次电子 DOCX 发行无需追加盖章或格式转换，原批准稿即为正式分发内容。",
		NoAdditionalSealRequired: true, NoConversionRequired: true,
	}
	if _, e = service.CDWVerifyControlledRelease(ctx, admin, prepared.ID,
		application.CDWControlVerificationInput{Justification: verifyInput.Justification,
			NoAdditionalSealRequired: false, NoConversionRequired: true}, 1, prefix+"_g8_unsafe"); !errors.Is(e, domain.ErrInvalidInput) {
		t.Fatalf("seal-needed release must fail closed: %v", e)
	}
	ready, e := service.CDWVerifyControlledRelease(ctx, admin, prepared.ID, verifyInput, 1, prefix+"_g8_verify")
	if e != nil || ready.State != "ready" || ready.Revision != 2 {
		t.Fatalf("verify distribution snapshot: %+v %v", ready, e)
	}
	replayedReady, e := service.CDWVerifyControlledRelease(ctx, admin, prepared.ID, verifyInput, 1, prefix+"_g8_verify")
	if e != nil || replayedReady.ID != ready.ID {
		t.Fatalf("verified idempotent replay: %+v %v", replayedReady, e)
	}
	if _, e = service.CDWVerifyControlledRelease(ctx, admin, prepared.ID, verifyInput, 1, prefix+"_g8_verify_stale"); !errors.Is(e, domain.ErrVersionConflict) {
		t.Fatalf("verified release CAS stale: %v", e)
	}
	var frozenDistribution int
	if e = pool.QueryRow(ctx, `SELECT COUNT(*) FROM cdw_release_artifacts a
 JOIN cdw_release_artifact_verifications v ON v.verified_artifact_id=a.id
 WHERE a.release_id=$1 AND a.purpose='distribution'
 AND a.sha256=$2 AND v.requires_additional_seal=false AND v.requires_conversion=false`,
		prepared.ID, sha).Scan(&frozenDistribution); e != nil {
		t.Fatal(e)
	}
	if frozenDistribution != 1 {
		t.Fatalf("missing separate verified distribution artifact=%d", frozenDistribution)
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM cdw_effective_pointers WHERE file_id=$1", fileID).Scan(&pointerCount); e != nil {
		t.Fatal(e)
	}
	if pointerCount != 0 {
		t.Fatal("ready artifact must never implicitly become effective")
	}
	deptB := prefix + "_g9_dept_b"
	deptC := prefix + "_g9_dept_c"
	if _, e = pool.Exec(ctx, `INSERT INTO departments(id,name) VALUES($1,'G9质量部'),($2,'G9文控部')`, deptB, deptC); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, `UPDATE users SET department_id=CASE WHEN id=$1 THEN $3 WHEN id=$2 THEN $4 ELSE department_id END
 WHERE id IN($1,$2)`, bob.ID, charlie.ID, deptB, deptC); e != nil {
		t.Fatal(e)
	}
	planInput := application.CDWDistributionCreateInput{ReleaseID: ready.ID,
		Targets: []ports.CDWDistributionTargetInput{
			{DepartmentID: deptB, ReceiverID: bob.ID}, {DepartmentID: deptC, ReceiverID: charlie.ID}}}
	if _, e = service.CDWDistributionCreate(ctx, alice, planInput, prefix+"_g9_no_role"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("not an authorized document-control officer: %v", e)
	}
	plan, e := service.CDWDistributionCreate(ctx, admin, planInput, prefix+"_g9_create")
	if e != nil || plan.State != "draft" || plan.DepartmentCount != 2 {
		t.Fatalf("real distribution draft %+v %v", plan, e)
	}
	againPlan, e := service.CDWDistributionCreate(ctx, admin, planInput, prefix+"_g9_create")
	if e != nil || againPlan.ID != plan.ID {
		t.Fatalf("plan idempotent replay %+v %v", againPlan, e)
	}
	if _, e = service.CDWDistributionCreate(ctx, admin, planInput, prefix+"_g9_duplicate"); !errors.Is(e, domain.ErrConflict) {
		t.Fatalf("second plan from same frozen release should be blocked %v", e)
	}
	frozenPlan, e := service.CDWDistributionFreeze(ctx, admin, plan.ID, 1, prefix+"_g9_freeze")
	if e != nil || frozenPlan.State != "frozen" || len(frozenPlan.DigestSHA256) != 64 {
		t.Fatalf("frozen distribution scope %+v %v", frozenPlan, e)
	}
	if _, e = service.CDWDistributionFreeze(ctx, admin, plan.ID, 1, prefix+"_g9_frozen_stale"); !errors.Is(e, domain.ErrVersionConflict) {
		t.Fatalf("stale frozen plan should fail CAS: %v", e)
	}
	readPlan, e := service.CDWDistributionRead(ctx, admin, plan.ID)
	if e != nil || readPlan.DigestSHA256 != frozenPlan.DigestSHA256 {
		t.Fatalf("frozen scope retrieval %+v %v", readPlan, e)
	}
	if _, e = pool.Exec(ctx, `UPDATE cdw_distribution_plan_targets SET designated_receiver_id=$2 WHERE plan_id=$1 AND department_id=$3`,
		plan.ID, charlie.ID, deptB); e == nil {
		t.Fatal("mutating frozen distribution scope accepted by DB")
	}
	var scopeApprovals, batches int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM cdw_distribution_scope_approvals WHERE plan_id=$1", plan.ID).Scan(&scopeApprovals); e != nil {
		t.Fatal(e)
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM cdw_distribution_batches WHERE plan_id=$1", plan.ID).Scan(&batches); e != nil {
		t.Fatal(e)
	}
	if scopeApprovals != 0 || batches != 0 {
		t.Fatalf("draft/freeze silently approved/dispatched scope %d/%d", scopeApprovals, batches)
	}
	if _, e = service.CDWApproveDistributionScope(ctx, admin, plan.ID, 2, prefix+"_g9_scope_author"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("plan creator must not approve own scope: %v", e)
	}
	if _, e = service.CDWApproveDistributionScope(ctx, alice, plan.ID, 2, prefix+"_g9_scope_no_role"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("unappointed scope approver accepted: %v", e)
	}
	scopeRole, e := service.CDWGrantDistributionScopeApprover(ctx, admin, application.CDWDistributionScopeRoleInput{
		FileID: fileID, UserID: alice.ID}, prefix+"_g9_scope_grant")
	if e != nil || scopeRole.ID == "" {
		t.Fatalf("scope role grant %+v %v", scopeRole, e)
	}
	scopeInbox, e := service.CDWDistributionScopeInbox(ctx, alice, 100)
	if e != nil {
		t.Fatal(e)
	}
	sawPlan := false
	for _, row := range scopeInbox {
		if row.ID == plan.ID && row.DigestSHA256 == frozenPlan.DigestSHA256 {
			sawPlan = true
		}
	}
	if !sawPlan {
		t.Fatalf("appointed principal must see frozen scope %+v", scopeInbox)
	}
	approvedPlan, e := service.CDWApproveDistributionScope(ctx, alice, plan.ID, 2, prefix+"_g9_scope_approve")
	if e != nil || approvedPlan.State != "approved" || approvedPlan.DigestSHA256 != frozenPlan.DigestSHA256 {
		t.Fatalf("immutable digest scope approval %+v %v", approvedPlan, e)
	}
	againApproved, e := service.CDWApproveDistributionScope(ctx, alice, plan.ID, 2, prefix+"_g9_scope_approve")
	if e != nil || againApproved.ID != plan.ID {
		t.Fatalf("scope replay %+v %v", againApproved, e)
	}
	if _, e = service.CDWApproveDistributionScope(ctx, alice, plan.ID, 2, prefix+"_g9_scope_stale"); !errors.Is(e, domain.ErrVersionConflict) {
		t.Fatalf("scope CAS stale must fail: %v", e)
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM cdw_distribution_scope_approvals WHERE plan_id=$1 AND plan_digest_sha256=$2", plan.ID, frozenPlan.DigestSHA256).Scan(&scopeApprovals); e != nil {
		t.Fatal(e)
	}
	if scopeApprovals != 1 {
		t.Fatalf("scope approval evidence rows=%d", scopeApprovals)
	}
	if _, e = service.CDWIssueControlledRelease(ctx, alice, ready.ID, 2, prefix+"_g9_wrong_issuer"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("scope approver cannot issue without document-control role: %v", e)
	}
	issued, e := service.CDWIssueControlledRelease(ctx, admin, ready.ID, 2, prefix+"_g9_issue")
	if e != nil || issued.State != "issued_pending" || issued.Revision != 3 {
		t.Fatalf("formal issue %+v %v", issued, e)
	}
	issuedReplay, e := service.CDWIssueControlledRelease(ctx, admin, ready.ID, 2, prefix+"_g9_issue")
	if e != nil || issuedReplay.ID != issued.ID {
		t.Fatalf("issue idempotent replay %+v %v", issuedReplay, e)
	}
	if _, e = service.CDWIssueControlledRelease(ctx, admin, ready.ID, 2, prefix+"_g9_issue_stale"); !errors.Is(e, domain.ErrVersionConflict) {
		t.Fatalf("issue CAS stale %v", e)
	}
	if _, e = service.CDWDispatchDistribution(ctx, alice, plan.ID, 3, prefix+"_g9_wrong_dispatcher"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("scope approver cannot dispatch without document-control role: %v", e)
	}
	batch, e := service.CDWDispatchDistribution(ctx, admin, plan.ID, 3, prefix+"_g9_dispatch")
	if e != nil || batch.State != "dispatched" || batch.DepartmentCount != 2 || batch.DigestSHA256 != approvedPlan.DigestSHA256 {
		t.Fatalf("atomic controlled distribution batch %+v %v", batch, e)
	}
	replayedBatch, e := service.CDWDispatchDistribution(ctx, admin, plan.ID, 3, prefix+"_g9_dispatch")
	if e != nil || replayedBatch.ID != batch.ID {
		t.Fatalf("batch replay %+v %v", replayedBatch, e)
	}
	if _, e = service.CDWDispatchDistribution(ctx, admin, plan.ID, 3, prefix+"_g9_stale_dispatch"); !errors.Is(e, domain.ErrVersionConflict) {
		t.Fatalf("dispatch CAS stale %v", e)
	}
	var batchItems, targets, requirements, accessGrants, heads, receiptCount, readingCount int
	for i, q := range []string{
		"SELECT COUNT(*) FROM cdw_distribution_batch_items WHERE batch_id=$1",
		"SELECT COUNT(*) FROM cdw_distribution_targets WHERE batch_id=$1",
		"SELECT COUNT(*) FROM cdw_target_item_requirements WHERE batch_id=$1",
		"SELECT COUNT(*) FROM cdw_release_access_grants g JOIN cdw_distribution_batch_items i ON i.id=g.batch_item_id WHERE i.batch_id=$1",
		"SELECT COUNT(*) FROM cdw_target_receipt_heads h JOIN cdw_distribution_targets t ON t.id=h.target_id WHERE t.batch_id=$1",
		"SELECT COUNT(*) FROM cdw_department_receipts r JOIN cdw_distribution_targets t ON t.id=r.target_id WHERE t.batch_id=$1",
		"SELECT COUNT(*) FROM cdw_reading_assignments r WHERE r.batch_id=$1",
	} {
		var n int
		if e = pool.QueryRow(ctx, q, batch.ID).Scan(&n); e != nil {
			t.Fatalf("evidence query %d: %v", i, e)
		}
		switch i {
		case 0:
			batchItems = n
		case 1:
			targets = n
		case 2:
			requirements = n
		case 3:
			accessGrants = n
		case 4:
			heads = n
		case 5:
			receiptCount = n
		case 6:
			readingCount = n
		}
	}
	if batchItems != 1 || targets != 2 || requirements != 2 || accessGrants != 2 || heads != 2 || receiptCount != 0 || readingCount != 0 {
		t.Fatalf("batch snapshot mismatch items=%d targets=%d requirements=%d grants=%d heads=%d receipts=%d readings=%d",
			batchItems, targets, requirements, accessGrants, heads, receiptCount, readingCount)
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM cdw_effective_pointers WHERE file_id=$1", fileID).Scan(&pointerCount); e != nil {
		t.Fatal(e)
	}
	if pointerCount != 0 {
		t.Fatal("issue/dispatch cannot activate default effective pointer")
	}
	t.Logf("CDW_G9_DISPATCH_POSTGRES_PASS batch=%s departments=2 grants=2 receipts=0 reading=0 effective_pointer=none", batch.ID)
	t.Logf("CDW_G9_SCOPE_APPROVED_POSTGRES_PASS plan=%s digest=%s batch=none", plan.ID, approvedPlan.DigestSHA256)
	t.Logf("CDW_G9_SCOPE_FROZEN_POSTGRES_PASS plan=%s departments=2 digest=%s issued=none", plan.ID, frozenPlan.DigestSHA256)
	t.Logf("CDW_G8_VERIFIED_ARTIFACT_PASS release=%s sha=%s still_not_effective", ready.ID, sha)
	t.Logf("CDW_G8_PREPARE_POSTGRES_PASS release=%s sha=%s active_pointer=none", prepared.ID, sha)
	t.Logf("CDW_G7_FORMAL_POSTGRES_PASS subject=%s candidate=%s sha=%s steps=2", started.SubjectID, final.CandidateID, sha)
}
