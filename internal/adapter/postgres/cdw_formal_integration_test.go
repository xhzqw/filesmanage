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
	// QMS rule 77A: the existing admin-granted role alone is insufficient to
	// publish a new official QMS template, or to assert an imaginary policy.
	qmsName := "qms_" + prefix + "_document_correction"
	qmsSteps := []ports.CDWFormalStepDefinition{{NodeKey: "management_representative", Sequence: 1, ApproverID: bob.ID},
		{NodeKey: "general_manager", Sequence: 2, ApproverID: charlie.ID}}
	if _, e := service.CDWPublishFormalTemplate(ctx, admin, application.CDWFormalTemplateInput{
		TemplateKey: qmsName, Steps: qmsSteps,
	}, prefix+"_qms_no_basis"); !errors.Is(e, domain.ErrPolicyAuthorityPending) {
		t.Fatalf("unverified QMS template was published: %v", e)
	}
	if _, e := service.CDWPublishFormalTemplate(ctx, admin, application.CDWFormalTemplateInput{
		TemplateKey: qmsName, Steps: qmsSteps, AuthorityBasisReleaseID: "missing_policy_release",
	}, prefix+"_qms_fake_basis"); !errors.Is(e, domain.ErrPolicyAuthorityPending) {
		t.Fatalf("imaginary QMS policy was accepted: %v", e)
	}
	if _, e := service.CDWGrantFormalApprover(ctx, admin, application.CDWFormalRoleInput{
		UserID: bob.ID, FileID: fileID, AuthorityBasisReleaseID: "missing_policy_release",
	}, prefix+"_qms_fake_role"); !errors.Is(e, domain.ErrPolicyAuthorityPending) {
		t.Fatalf("imaginary QMS approver appointment was accepted: %v", e)
	}
	if _, e := pool.Exec(ctx, `INSERT INTO cdw_workflow_template_versions
	 (id,template_key,version_no,lifecycle,graph,role_policy,published_at,created_by)
	 VALUES($1,$2,1,'published','{"type":"formal_document"}'::jsonb,
	 '{"formalApproval":true}'::jsonb,now(),$3)`,
		prefix+"_qms_direct_bypass", qmsName, admin.ID); e == nil {
		t.Fatal("database permitted publishing a QMS template without policy evidence")
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
	// A valid generic template and an administrator's approver grants are NOT
	// sufficient to approve a file with no documented classification.
	classification, e := service.CDWDocumentClass(ctx, admin, fileID)
	if e != nil || classification.ApprovalClass != "pending" {
		t.Fatalf("unclassified file erroneously recognized %+v %v", classification, e)
	}
	if _, e = service.CDWStartFormalApproval(ctx, admin, application.CDWFormalStartInput{
		DeliveryID: frozen.DeliveryID, TemplateVersionID: tpl.ID}, prefix+"_unclassified_start"); !errors.Is(e, domain.ErrDocumentClassPending) {
		t.Fatalf("generic formal approval bypassed pending document class: %v", e)
	}
	if _, e = service.CDWClassifyDocument(ctx, bob, fileID, application.CDWDocumentClassInput{
		ApprovalClass: "general", Reason: "非质量受控文件，依据项目任务范围核对登记为普通行政交付文档。"}, prefix+"_unauthorized_class"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("non-document-controller classified formal file: %v", e)
	}
	if _, e = service.CDWControlGrantRole(ctx, admin, application.CDWControlRoleInput{
		UserID: charlie.ID, FileID: fileID}, prefix+"_class_document_control"); e != nil {
		t.Fatalf("designate fixture document control: %v", e)
	}
	classification, e = service.CDWClassifyDocument(ctx, charlie, fileID, application.CDWDocumentClassInput{
		ApprovalClass: "general", Reason: "本例为演示用普通交付文件，并非质量体系受控原件，文控核对后归类。"}, prefix+"_class_general")
	if e != nil || classification.ApprovalClass != "general" || classification.ClassifiedBy != charlie.ID {
		t.Fatalf("document-controlled classification failed %+v %v", classification, e)
	}
	if _, e = service.CDWClassifyDocument(ctx, charlie, fileID, application.CDWDocumentClassInput{
		ApprovalClass: "qms", Reason: "尝试事后无凭证修改已确认文件类别，不应允许更改历史正式分类。"}, prefix+"_class_escalate"); !errors.Is(e, domain.ErrConflict) {
		t.Fatalf("existing formal document class was overwritten: %v", e)
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
			{DepartmentID: deptB, ReceiverID: bob.ID, Channel: "mixed", PaperQuantity: 2},
			{DepartmentID: deptC, ReceiverID: charlie.ID, Channel: "electronic"}}}
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
	// Explicit opt-in is independent of planned effective time.
	if _, e = service.CDWScheduleSet(ctx, admin, issued.ID, issued.Revision, true, prefix+"_sched_no_date"); !errors.Is(e, domain.ErrConflict) {
		t.Fatalf("automatic activation accepted without a planned date: %v", e)
	}
	if _, e = pool.Exec(ctx, `UPDATE cdw_controlled_releases
	 SET planned_effective_at=clock_timestamp()+interval '2 hours' WHERE id=$1`, issued.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = service.CDWScheduleSet(ctx, alice, issued.ID, issued.Revision, true, prefix+"_sched_wrong_role"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("unprivileged schedule enable accepted: %v", e)
	}
	schedule, e := service.CDWScheduleSet(ctx, admin, issued.ID, issued.Revision, true, prefix+"_sched_enable")
	if e != nil || schedule.Status != "enabled" || schedule.ReleaseRevision != issued.Revision+1 ||
		schedule.SponsorID != admin.ID || schedule.Attempts != 0 {
		t.Fatalf("explicit schedule opt-in %+v %v", schedule, e)
	}
	replaySchedule, e := service.CDWScheduleSet(ctx, admin, issued.ID, issued.Revision, true, prefix+"_sched_enable")
	if e != nil || replaySchedule.Revision != schedule.Revision {
		t.Fatalf("schedule idempotent replay %+v %v", replaySchedule, e)
	}
	if _, e = service.CDWScheduleSet(ctx, admin, issued.ID, issued.Revision, false, prefix+"_sched_stale"); !errors.Is(e, domain.ErrVersionConflict) {
		t.Fatalf("stale schedule changed authorized release: %v", e)
	}
	issued.Revision = schedule.ReleaseRevision
	if _, claimed, claimErr := repo.CDWClaimDueActivation(ctx); claimErr != nil || claimed {
		t.Fatalf("scheduler claimed before due date: %t %v", claimed, claimErr)
	}
	// Queue clock advances only in this isolated fixture; the immutable G8
	// planned-time gate remains in the future and must still block.
	if _, e = pool.Exec(ctx, `UPDATE cdw_activation_schedules
	 SET next_attempt_at=clock_timestamp()-interval '1 minute' WHERE release_id=$1`, issued.ID); e != nil {
		t.Fatal(e)
	}
	claim, claimed, e := repo.CDWClaimDueActivation(ctx)
	if e != nil || !claimed || claim.ReleaseID != issued.ID || claim.SponsorID != admin.ID || claim.ReleaseRevision != issued.Revision {
		t.Fatalf("lease claim %+v claimed=%t err=%v", claim, claimed, e)
	}
	if _, claimed, e = repo.CDWClaimDueActivation(ctx); e != nil || claimed {
		t.Fatalf("scheduler duplicated in-flight lease claimed=%t err=%v", claimed, e)
	}
	blockedScheduled, e := service.CDWRunScheduledActivation(ctx, claim)
	if e != nil || blockedScheduled.Outcome != "blocked" || len(blockedScheduled.Blockers) < 2 {
		t.Fatalf("scheduler skipped planned time or unsigned target gate: %+v %v", blockedScheduled, e)
	}
	queueState, e := service.CDWScheduleRead(ctx, admin, issued.ID)
	if e != nil || queueState.Status != "enabled" || queueState.Attempts != 1 || len(queueState.LastBlockers) < 2 {
		t.Fatalf("scheduler did not persist retry and reasons: %+v %v", queueState, e)
	}
	var schedulerAttempts int
	if e = pool.QueryRow(ctx, `SELECT count(*) FROM cdw_activation_attempts
	 WHERE release_id=$1 AND trigger_kind='scheduler' AND outcome='blocked'`, issued.ID).Scan(&schedulerAttempts); e != nil {
		t.Fatal(e)
	}
	if schedulerAttempts != 1 {
		t.Fatalf("scheduler generated %d immutable blocked attempts", schedulerAttempts)
	}
	if _, e = service.CDWScheduleSet(ctx, admin, issued.ID, issued.Revision, false, prefix+"_sched_cancel"); e != nil {
		t.Fatalf("explicit cancellation: %v", e)
	}
	issued.Revision++
	if _, e = service.CDWScheduleSet(ctx, admin, issued.ID, issued.Revision, true, prefix+"_sched_reenable"); e != nil {
		t.Fatalf("authorized re-enable: %v", e)
	}
	issued.Revision++
	// Cancelled credentials cannot be laundered through a previously granted
	// timer. The failure is paused and retained as a separate immutable fact.
	if _, e = pool.Exec(ctx, `UPDATE cdw_activation_schedules
	 SET next_attempt_at=clock_timestamp()-interval '1 minute' WHERE release_id=$1`, issued.ID); e != nil {
		t.Fatal(e)
	}
	claimDenied, claimed, e := repo.CDWClaimDueActivation(ctx)
	if e != nil || !claimed {
		t.Fatalf("revocation fixture could not claim %t %v", claimed, e)
	}
	if _, e = pool.Exec(ctx, `UPDATE users SET disabled_at=clock_timestamp() WHERE id=$1`, admin.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = service.CDWRunScheduledActivation(ctx, claimDenied); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("disabled sponsor still authorized auto activation: %v", e)
	}
	if finalized, finalErr := repo.CDWScheduleFailClaim(ctx, claimDenied.ReleaseID, claimDenied.LeaseToken, true); finalErr != nil || !finalized {
		t.Fatalf("disabled sponsor failure was not durably paused: %t %v", finalized, finalErr)
	}
	if _, e = pool.Exec(ctx, `UPDATE users SET disabled_at=NULL WHERE id=$1`, admin.ID); e != nil {
		t.Fatal(e)
	}
	paused, e := service.CDWScheduleRead(ctx, admin, issued.ID)
	if e != nil || paused.Status != "paused" || paused.LastError != "authorization_or_release_changed" {
		t.Fatalf("revocation not surfaced as paused schedule %+v %v", paused, e)
	}
	if _, e = service.CDWScheduleSet(ctx, admin, issued.ID, issued.Revision, true, prefix+"_sched_reenable_after_pause"); e != nil {
		t.Fatalf("controller failed to explicitly reauthorize paused timer: %v", e)
	}
	issued.Revision++
	t.Log("CDW_G8_SCHEDULE_POSTGRES_PASS opt-in, idempotency, CAS, lease exclusivity, time gate, blocker retry and cancellation")
	blockedActivation, e := service.CDWActivateRelease(ctx, admin, issued.ID, issued.Revision, prefix+"_g8_blocked_activation")
	if e != nil || blockedActivation.Outcome != "blocked" || blockedActivation.Revision != issued.Revision ||
		len(blockedActivation.Blockers) < 2 {
		t.Fatalf("premature activation permitted or missing gate evidence: %+v %v", blockedActivation, e)
	}
	blockedReplay, e := service.CDWActivateRelease(ctx, admin, issued.ID, issued.Revision, prefix+"_g8_blocked_activation")
	if e != nil || len(blockedReplay.Blockers) != len(blockedActivation.Blockers) {
		t.Fatalf("activation blocker replay %+v %v", blockedReplay, e)
	}
	activationHistory, e := service.CDWActivationHistory(ctx, admin, issued.ID)
	if e != nil || len(activationHistory) != 3 || activationHistory[0].Outcome != "blocked" ||
		len(activationHistory[0].Blockers) < 2 || activationHistory[0].ActorID != admin.ID {
		t.Fatalf("durable activation history must expose exact blockers once: %+v %v", activationHistory, e)
	}
	if activationHistory[0].TriggerKind != "manual" || activationHistory[1].TriggerKind != "scheduler" || activationHistory[1].Outcome != "failed" {
		t.Fatalf("scheduled and manual evidence source confused %+v", activationHistory)
	}
	if _, e = service.CDWActivationHistory(ctx, alice, issued.ID); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("unprivileged user read activation evidence: %v", e)
	}
	if _, e = service.CDWActivateRelease(ctx, alice, issued.ID, issued.Revision, prefix+"_g8_unauthorized_activation"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("unprivileged effective activation: %v", e)
	}
	bobTargets, e := service.CDWReceiptInbox(ctx, bob, 20)
	if e != nil || len(bobTargets) != 1 || bobTargets[0].State != "awaiting" ||
		bobTargets[0].ManifestSHA256 != approvedPlan.DigestSHA256 {
		t.Fatalf("designated receiver inbox %+v %v", bobTargets, e)
	}
	charlieTargets, e := service.CDWReceiptInbox(ctx, charlie, 20)
	if e != nil || len(charlieTargets) != 1 || charlieTargets[0].State != "awaiting" {
		t.Fatalf("second department inbox %+v %v", charlieTargets, e)
	}
	if _, e = service.CDWAcknowledgeDepartment(ctx, alice, bobTargets[0].TargetID, 1,
		application.CDWReceiptAcknowledgeInput{Statement: "我不是指定部门接收人，不得替代部门签收"}, prefix+"_g9_wrong_receipt"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("nonreceiver signed another department: %v", e)
	}
	ack := application.CDWReceiptAcknowledgeInput{Statement: "已核验受控文件版本及 SHA256，并确认本部门已收到指定发行稿"}
	bobReceipt, e := service.CDWAcknowledgeDepartment(ctx, bob, bobTargets[0].TargetID, 1, ack, prefix+"_g9_receipt_bob")
	if e != nil || bobReceipt.State != "received" || bobReceipt.Revision != 2 || len(bobReceipt.EvidenceSHA256) != 64 {
		t.Fatalf("first department receipt %+v %v", bobReceipt, e)
	}
	bobReplay, e := service.CDWAcknowledgeDepartment(ctx, bob, bobTargets[0].TargetID, 1, ack, prefix+"_g9_receipt_bob")
	if e != nil || bobReplay.ReceiptID != bobReceipt.ReceiptID {
		t.Fatalf("receipt replay %+v %v", bobReplay, e)
	}
	if _, e = service.CDWAcknowledgeDepartment(ctx, bob, bobTargets[0].TargetID, 1, ack, prefix+"_g9_receipt_bob_stale"); !errors.Is(e, domain.ErrVersionConflict) {
		t.Fatalf("duplicate receipt did not enforce CAS: %v", e)
	}
	if e = pool.QueryRow(ctx, `SELECT COUNT(*) FROM cdw_department_receipts r JOIN cdw_distribution_targets t
	 ON t.id=r.target_id WHERE t.batch_id=$1`, batch.ID).Scan(&receiptCount); e != nil {
		t.Fatal(e)
	}
	if receiptCount != 1 {
		t.Fatalf("partial receipt count=%d", receiptCount)
	}
	if _, e = pool.Exec(ctx, `UPDATE cdw_business_role_bindings SET revoked_at=now()
	 WHERE user_id=$1 AND department_id=$2 AND role='department_receiver'`, charlie.ID, deptC); e != nil {
		t.Fatal(e)
	}
	if _, e = service.CDWAcknowledgeDepartment(ctx, charlie, charlieTargets[0].TargetID, 1, ack, prefix+"_g9_revoked_receiver"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("revoked department receiver signed: %v", e)
	}
	if _, e = pool.Exec(ctx, `UPDATE cdw_business_role_bindings SET revoked_at=NULL
	 WHERE user_id=$1 AND department_id=$2 AND role='department_receiver'`, charlie.ID, deptC); e != nil {
		t.Fatal(e)
	}
	charlieReceipt, e := service.CDWAcknowledgeDepartment(ctx, charlie, charlieTargets[0].TargetID, 1, ack, prefix+"_g9_receipt_charlie")
	if e != nil || charlieReceipt.ActorID != charlie.ID {
		t.Fatalf("second department receipt %+v %v", charlieReceipt, e)
	}
	if e = pool.QueryRow(ctx, `SELECT COUNT(*) FROM cdw_department_receipts r JOIN cdw_distribution_targets t
	 ON t.id=r.target_id WHERE t.batch_id=$1`, batch.ID).Scan(&receiptCount); e != nil {
		t.Fatal(e)
	}
	if receiptCount != 2 {
		t.Fatalf("department receipts should be independently signed: %d", receiptCount)
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM cdw_reading_assignments WHERE batch_id=$1", batch.ID).Scan(&readingCount); e != nil {
		t.Fatal(e)
	}
	if readingCount != 0 {
		t.Fatal("receipt cannot create or complete personal reading assignment")
	}
	t.Logf("CDW_G9_DEPARTMENT_RECEIPTS_POSTGRES_PASS batch=%s receipts=2 reading=0", batch.ID)
	if _, e = service.CDWCreateReadingRoster(ctx, alice, bobTargets[0].TargetID,
		application.CDWReadingRosterInput{UserIDs: []string{bob.ID}}, prefix+"_g9_roster_unauthorized"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("not appointed department receiver cannot set reading roster: %v", e)
	}
	bobRosterInput := application.CDWReadingRosterInput{UserIDs: []string{bob.ID}}
	bobRoster, e := service.CDWCreateReadingRoster(ctx, bob, bobTargets[0].TargetID, bobRosterInput, prefix+"_g9_roster_bob")
	if e != nil || bobRoster.AssignedCount != 1 || len(bobRoster.DigestSHA256) != 64 {
		t.Fatalf("recipient created bounded reading roster %+v %v", bobRoster, e)
	}
	bobRosterAgain, e := service.CDWCreateReadingRoster(ctx, bob, bobTargets[0].TargetID, bobRosterInput, prefix+"_g9_roster_bob")
	if e != nil || bobRosterAgain.ID != bobRoster.ID {
		t.Fatalf("reading roster replay %+v %v", bobRosterAgain, e)
	}
	if _, e = service.CDWCreateReadingRoster(ctx, bob, bobTargets[0].TargetID, bobRosterInput, prefix+"_g9_roster_duplicate"); !errors.Is(e, domain.ErrConflict) {
		t.Fatalf("second reading roster permitted: %v", e)
	}
	inboxRead, e := service.CDWReadingInbox(ctx, bob, 25)
	if e != nil {
		t.Fatal(e)
	}
	var bobAssignment ports.CDWReadingAssignment
	for _, candidate := range inboxRead {
		if candidate.TargetID == bobTargets[0].TargetID {
			bobAssignment = candidate
		}
	}
	if bobAssignment.ID == "" || bobAssignment.State != "assigned" || bobAssignment.ArtifactSHA256 != bobTargets[0].ArtifactSHA256 {
		t.Fatalf("personal reading assignment not frozen to exact distribution artifact %+v", inboxRead)
	}
	if _, e = service.CDWConfirmReading(ctx, charlie, bobAssignment.ID,
		application.CDWReadingConfirmationInput{Statement: "我已阅读上述文件版本并确认理解"}, prefix+"_g9_wrong_reader"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("another reader confirmed Bob's assigned version: %v", e)
	}
	readingStatement := application.CDWReadingConfirmationInput{Statement: "本人已核对本次受控发行的文档内容和版次，确认已经阅读。"}
	if _, e = service.CDWConfirmReading(ctx, bob, bobAssignment.ID, readingStatement, prefix+"_g9_read_without_open"); !errors.Is(e, domain.ErrConflict) {
		t.Fatalf("reading confirmed without full controlled-content delivery: %v", e)
	}
	if e = service.CDWReadingContentDelivered(ctx, charlie, bobAssignment.ID); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("different person manufactured open evidence: %v", e)
	}
	// The streaming layer invokes this hook only after an actual successful
	// full-size copy. This integration test verifies its DB state and ACL.
	if e = service.CDWReadingContentDelivered(ctx, bob, bobAssignment.ID); e != nil {
		t.Fatalf("post-transfer opened evidence failed: %v", e)
	}
	if e = service.CDWReadingContentDelivered(ctx, bob, bobAssignment.ID); e != nil {
		t.Fatalf("idempotent full-transfer evidence: %v", e)
	}
	var openEvents int
	if e = pool.QueryRow(ctx, `SELECT COUNT(*) FROM cdw_reading_events
	 WHERE assignment_id=$1 AND actor_id=$2 AND kind='opened' AND artifact_sha256=$3`,
		bobAssignment.ID, bob.ID, bobAssignment.ArtifactSHA256).Scan(&openEvents); e != nil {
		t.Fatal(e)
	}
	if openEvents != 1 {
		t.Fatalf("duplicate or missing immutable delivery evidence: %d", openEvents)
	}
	confirmed, e := service.CDWConfirmReading(ctx, bob, bobAssignment.ID, readingStatement, prefix+"_g9_read_bob")
	if e != nil || confirmed.State != "confirmed" || confirmed.ArtifactSHA256 != bobAssignment.ArtifactSHA256 {
		t.Fatalf("personal read confirmation %+v %v", confirmed, e)
	}
	confirmedAgain, e := service.CDWConfirmReading(ctx, bob, bobAssignment.ID, readingStatement, prefix+"_g9_read_bob")
	if e != nil || confirmedAgain.EventID != confirmed.EventID {
		t.Fatalf("reading idempotent replay %+v %v", confirmedAgain, e)
	}
	if _, e = service.CDWConfirmReading(ctx, bob, bobAssignment.ID, readingStatement, prefix+"_g9_read_again"); !errors.Is(e, domain.ErrConflict) {
		t.Fatalf("duplicate reading confirmation not blocked: %v", e)
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM cdw_reading_events WHERE assignment_id=$1 AND kind='confirmed'", bobAssignment.ID).Scan(&readingCount); e != nil {
		t.Fatal(e)
	}
	if readingCount != 1 {
		t.Fatalf("reading confirmation immutable evidence count=%d", readingCount)
	}
	if _, e = service.CDWDistributionLedger(ctx, alice, plan.ID); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("scope approver without document-control role saw confidential department ledger: %v", e)
	}
	ledger, e := service.CDWDistributionLedger(ctx, admin, plan.ID)
	if e != nil || ledger.ManifestSHA256 != frozenPlan.DigestSHA256 ||
		ledger.ReceiptCompleted != 2 || ledger.ReadingAssigned != 1 || ledger.ReadingConfirmed != 1 || len(ledger.Rows) != 2 {
		t.Fatalf("real controlled distribution ledger %+v %v", ledger, e)
	}
	var foundBob, foundCharlie bool
	for _, row := range ledger.Rows {
		if row.DepartmentID == deptB {
			foundBob = row.ReceiptStatus == "received" && row.ActualSignerID != nil &&
				*row.ActualSignerID == bob.ID && row.SignedAt != nil && row.ReadingStatus == "confirmed" && row.ReadingConfirmed == 1
		}
		if row.DepartmentID == deptC {
			foundCharlie = row.ReceiptStatus == "received" && row.ActualSignerID != nil &&
				*row.ActualSignerID == charlie.ID && row.ReadingStatus == "unassigned" && row.ReadingAssigned == 0
		}
	}
	if !foundBob || !foundCharlie {
		t.Fatalf("ledger must reflect independent department evidence %+v", ledger.Rows)
	}
	// G10 independently tracks actual physical copies, not online reads.
	if _, e = service.CDWPaperIssue(ctx, admin, charlieTargets[0].TargetID, 1,
		application.CDWPaperIssueInput{CopyNumbers: []string{"PHYSICAL-C1"}}, prefix+"_g10_electronic_issue"); !errors.Is(e, domain.ErrConflict) {
		t.Fatalf("electronic-only department issued paper: %v", e)
	}
	if _, e = service.CDWPaperIssue(ctx, admin, bobTargets[0].TargetID, 1,
		application.CDWPaperIssueInput{CopyNumbers: []string{"PHYSICAL-B1"}}, prefix+"_g10_wrong_quantity"); !errors.Is(e, domain.ErrConflict) {
		t.Fatalf("partial physical lot bypassed frozen count: %v", e)
	}
	lotInput := application.CDWPaperIssueInput{CopyNumbers: []string{prefix + "-B01", prefix + "-B02"}}
	if _, e = service.CDWPaperIssue(ctx, alice, bobTargets[0].TargetID, 1, lotInput, prefix+"_g10_unauthorized_issue"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("non-controller issued physical copies: %v", e)
	}
	issuedPaper, e := service.CDWPaperIssue(ctx, admin, bobTargets[0].TargetID, 1, lotInput, prefix+"_g10_issue")
	if e != nil || issuedPaper.Issued != 2 || issuedPaper.Outstanding != 2 || len(issuedPaper.Copies) != 2 {
		t.Fatalf("physical issue count or frozen roster %+v %v", issuedPaper, e)
	}
	replayedPaper, e := service.CDWPaperIssue(ctx, admin, bobTargets[0].TargetID, 1, lotInput, prefix+"_g10_issue")
	if e != nil || replayedPaper.LotID != issuedPaper.LotID {
		t.Fatalf("paper issue replay %+v %v", replayedPaper, e)
	}
	if _, e = service.CDWPaperIssue(ctx, admin, bobTargets[0].TargetID, 1, lotInput, prefix+"_g10_duplicate"); !errors.Is(e, domain.ErrVersionConflict) {
		t.Fatalf("physical issue repeated despite CAS: %v", e)
	}
	physicalReason := "已核实纸质编号、实际交接人员及原始受控文件实物，并登记交接凭证。"
	physicalRecord := application.CDWPaperTransitionInput{Kind: "collected", Reason: physicalReason}
	if _, e = service.CDWPaperRecord(ctx, alice, issuedPaper.Copies[0].ID, 1, physicalRecord, prefix+"_g10_unprivileged_collect"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("unauthorized collection changed physical evidence: %v", e)
	}
	collected, e := service.CDWPaperRecord(ctx, admin, issuedPaper.Copies[0].ID, 1, physicalRecord, prefix+"_g10_collect")
	if e != nil || collected.Revision != 2 || collected.State != "collected" {
		t.Fatalf("physical collection %+v %v", collected, e)
	}
	if _, e = service.CDWPaperRecord(ctx, admin, issuedPaper.Copies[0].ID, 1, physicalRecord, prefix+"_g10_collect_stale"); !errors.Is(e, domain.ErrVersionConflict) {
		t.Fatalf("concurrent stale physical collection accepted: %v", e)
	}
	last, e := service.CDWPaperLedger(ctx, admin, bobTargets[0].TargetID)
	if e != nil || last.Collected != 1 || last.Outstanding != 1 || last.Issued != 2 {
		t.Fatalf("partial paper return incorrectly completed: %+v %v", last, e)
	}
	lost, e := service.CDWPaperRecord(ctx, admin, issuedPaper.Copies[1].ID, 1,
		application.CDWPaperTransitionInput{Kind: "lost", Reason: "实物保管人报告纸质受控副本遗失，已登记异常等待后续处置。"}, prefix+"_g10_lost")
	if e != nil || lost.State != "lost" {
		t.Fatalf("lost copy not separately evidenced: %+v %v", lost, e)
	}
	endLedger, e := service.CDWPaperLedger(ctx, admin, bobTargets[0].TargetID)
	if e != nil || endLedger.Issued != 2 || endLedger.Collected != 1 || endLedger.Lost != 1 || endLedger.Outstanding != 1 {
		t.Fatalf("paper statuses must not confuse lost with collected %+v %v", endLedger, e)
	}
	t.Logf("CDW_G10_PAPER_POSTGRES_PASS lot=%s copies=2 collected=1 lost=1; neither personal reading nor batch receipt counts as recovery", issuedPaper.LotID)
	// Preserve the second department's real pending reading assignment after
	// this rollback so subsequent G9 withdrawal can cancel it.
	charlieRoster, e := service.CDWCreateReadingRoster(ctx, charlie, charlieTargets[0].TargetID,
		application.CDWReadingRosterInput{UserIDs: []string{charlie.ID}}, prefix+"_g9_roster_charlie")
	if e != nil || charlieRoster.AssignedCount != 1 {
		t.Fatalf("pending reading before withdrawal %+v %v", charlieRoster, e)
	}
	charlieReadItems, e := service.CDWReadingInbox(ctx, charlie, 25)
	if e != nil {
		t.Fatal(e)
	}
	charlieReadID := ""
	for _, item := range charlieReadItems {
		if item.TargetID == charlieTargets[0].TargetID {
			charlieReadID = item.ID
		}
	}
	if charlieReadID == "" {
		t.Fatal("second department missing designated pending reader")
	}
	// Exercise the real G8 activation transaction in a rolled-back isolated
	// fixture. Its synthetic final confirmation is *not* a browser E2E proof.
	readFixtureTx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer readFixtureTx.Rollback(ctx)
	if _, e = readFixtureTx.Exec(ctx, `UPDATE cdw_reading_assignments
	 SET state='confirmed',confirmed_at=clock_timestamp() WHERE id=$1`, charlieReadID); e != nil {
		t.Fatal(e)
	}
	if _, e = readFixtureTx.Exec(ctx, `UPDATE cdw_controlled_releases
	 SET planned_effective_at=clock_timestamp()-interval '1 minute' WHERE id=$1`, issued.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = readFixtureTx.Exec(ctx, `INSERT INTO cdw_reading_events
	 (id,assignment_id,actor_id,kind,artifact_sha256,statement_snapshot)
	 VALUES($1,$2,$3,'confirmed',$4,'transaction-gate-fixture')`,
		prefix+"_fixture_charlie_confirm", charlieReadID, charlie.ID, charlieTargets[0].ArtifactSHA256); e != nil {
		t.Fatal(e)
	}
	fixtureReader := &Repository{DB: pool, Q: readFixtureTx}
	if _, e = readFixtureTx.Exec(ctx, "SAVEPOINT cdw_scheduler_success_fixture"); e != nil {
		t.Fatal(e)
	}
	fixtureToken := prefix + "_scheduled_success_token"
	if _, e = readFixtureTx.Exec(ctx, `UPDATE cdw_activation_schedules SET
	 lease_token=$2,lease_until=clock_timestamp()+interval '2 minutes'
	 WHERE release_id=$1 AND status='enabled'`, issued.ID, fixtureToken); e != nil {
		t.Fatal(e)
	}
	leaseValid, e := fixtureReader.CDWScheduleVerifyLease(ctx, issued.ID, admin.ID, fixtureToken)
	if e != nil || !leaseValid {
		t.Fatalf("ready scheduled claim invalid: %t %v", leaseValid, e)
	}
	autoActivated, e := fixtureReader.CDWActivateReleaseWithTrigger(ctx, prefix+"_auto_success_attempt",
		issued.ID, admin.ID, issued.Revision, fixtureToken, "scheduler")
	if e != nil || autoActivated.Outcome != "activated" || autoActivated.PointerRevision != 1 {
		t.Fatalf("scheduler did not reuse the real atomic G8 activation: %+v %v", autoActivated, e)
	}
	if finalized, finishErr := fixtureReader.CDWScheduleFinish(ctx, issued.ID, fixtureToken, "completed", nil); finishErr != nil || !finalized {
		t.Fatalf("successful scheduler result did not atomically settle its lease: %t %v", finalized, finishErr)
	}
	var scheduledOutcome, scheduledState string
	if e = readFixtureTx.QueryRow(ctx, `SELECT outcome FROM cdw_activation_attempts
	 WHERE id=$1 AND trigger_kind='scheduler'`, prefix+"_auto_success_attempt").Scan(&scheduledOutcome); e != nil || scheduledOutcome != "activated" {
		t.Fatalf("scheduled activation lacks immutable success evidence: %q %v", scheduledOutcome, e)
	}
	if e = readFixtureTx.QueryRow(ctx, `SELECT status FROM cdw_activation_schedules
	 WHERE release_id=$1`, issued.ID).Scan(&scheduledState); e != nil || scheduledState != "completed" {
		t.Fatalf("successful scheduler still enabled: %q %v", scheduledState, e)
	}
	if _, e = readFixtureTx.Exec(ctx, "ROLLBACK TO SAVEPOINT cdw_scheduler_success_fixture"); e != nil {
		t.Fatal(e)
	}
	t.Log("CDW_G8_SCHEDULE_ACTIVATE_FIXTURE_PASS trigger=scheduler atomic-pointer+evidence+lease-completion, rolled back")
	activatedFixture, e := fixtureReader.CDWActivateRelease(ctx, prefix+"_activation_real_transaction",
		issued.ID, admin.ID, issued.Revision, prefix+"_g8_activate_fixture")
	if e != nil || activatedFixture.Outcome != "activated" || activatedFixture.PointerRevision != 1 ||
		activatedFixture.Revision != issued.Revision+1 || activatedFixture.EffectiveAt == nil {
		t.Fatalf("actual effective transaction failed %+v %v", activatedFixture, e)
	}
	// A controlled release becomes a valid source of policy provenance only
	// while its exact effective pointer is active. No legal appointment or
	// business signature is fabricated by this isolated transaction.
	if active, checkErr := fixtureReader.cdwQMSPolicyEffective(ctx, issued.ID); checkErr != nil || !active {
		t.Fatalf("effective QMS policy source not recognized: %t %v", active, checkErr)
	}
	qmsPolicyTemplate := prefix + "_qms_policy_test"
	if _, checkErr := fixtureReader.CDWPublishFormalTemplate(ctx, prefix+"_qms_tpl", "qms_"+qmsPolicyTemplate,
		qmsSteps, admin.ID, issued.ID); checkErr != nil {
		t.Fatalf("QMS template could not bind effective controlled source: %v", checkErr)
	}
	if _, checkErr := fixtureReader.CDWGrantFormalApprover(ctx, prefix+"_qms_wrong_general_role", bob.ID, fileID,
		admin.ID, issued.ID); !errors.Is(checkErr, domain.ErrDocumentClassPending) {
		t.Fatalf("general classified document incorrectly got a QMS approver: %v", checkErr)
	}
	qmsFileID := prefix + "_qms_controlled_subject"
	if _, checkErr := readFixtureTx.Exec(ctx, `INSERT INTO files(id,folder_id,name,uploaded_by)
 SELECT $1,folder_id,'ZS-QP-99 测试隔离质量控制程序.doc', $2 FROM files WHERE id=$3`,
		qmsFileID, admin.ID, fileID); checkErr != nil {
		t.Fatal(checkErr)
	}
	if _, checkErr := readFixtureTx.Exec(ctx, `INSERT INTO cdw_business_role_bindings
 (id,user_id,role,file_id,granted_by) VALUES($1,$2,'document_control',$3,$4)`,
		prefix+"_qms_class_officer", charlie.ID, qmsFileID, admin.ID); checkErr != nil {
		t.Fatal(checkErr)
	}
	if info, checkErr := fixtureReader.CDWFormalClass(ctx, qmsFileID); checkErr != nil ||
		info.ApprovalClass != "pending" || !info.RequiresQMS {
		t.Fatalf("source document title must force quality route: %+v %v", info, checkErr)
	}
	if _, checkErr := fixtureReader.CDWFormalClassify(ctx, qmsFileID, "general",
		"此文件为质量管理受控程序，任何错误归类普通文件的尝试均应被系统拒绝。", charlie.ID); !errors.Is(checkErr, domain.ErrDocumentClassPending) {
		t.Fatalf("QMS controlled source was misclassified general: %v", checkErr)
	}
	if info, checkErr := fixtureReader.CDWFormalClassify(ctx, qmsFileID, "qms",
		"依据原始质量控制程序编号、文控台账及受控制度适用性核定为质量体系文件。", charlie.ID); checkErr != nil || info.ApprovalClass != "qms" {
		t.Fatalf("document-control QMS registration rejected: %+v %v", info, checkErr)
	}
	if checkErr := fixtureReader.cdwFormalValidateClass(ctx, qmsFileID, "cdw-formal-generic", ""); !errors.Is(checkErr, domain.ErrDocumentClassPending) {
		t.Fatalf("generic template accepted a formally classified QMS file: %v", checkErr)
	}
	if checkErr := fixtureReader.cdwFormalValidateClass(ctx, qmsFileID, "qms_verified", issued.ID); checkErr != nil {
		t.Fatalf("valid QMS source and policy rejected: %v", checkErr)
	}
	// Database-level boundary: even privileged direct DML must not downgrade a
	// registered quality file or attach a generic approval without quality
	// policy evidence.
	if _, checkErr := readFixtureTx.Exec(ctx, "SAVEPOINT cdw_qms_class_immutable"); checkErr != nil {
		t.Fatal(checkErr)
	}
	if _, checkErr := readFixtureTx.Exec(ctx, `UPDATE cdw_document_profiles SET approval_class='general' WHERE file_id=$1`, qmsFileID); checkErr == nil {
		t.Fatal("database allowed downgrading a classified QMS document")
	}
	if _, checkErr := readFixtureTx.Exec(ctx, "ROLLBACK TO SAVEPOINT cdw_qms_class_immutable"); checkErr != nil {
		t.Fatal(checkErr)
	}
	qmsSubjectID := prefix + "_qms_direct_subject"
	var checkErr error
	if _, checkErr := readFixtureTx.Exec(ctx, `INSERT INTO cdw_approval_subjects
 (id,file_id,source_kind,blob_id,sha256,size_bytes,frozen_by)
 VALUES($1,$2,'existing_version',$3,$4,31,$5)`, qmsSubjectID, qmsFileID, blobID, sha, admin.ID); checkErr != nil {
		t.Fatal(checkErr)
	}
	if _, checkErr = readFixtureTx.Exec(ctx, "SAVEPOINT cdw_special_qms_77a"); checkErr != nil {
		t.Fatal(checkErr)
	}
	for _, name := range []string{"DHF-测试项目设计历史文件.docx", "DMR-测试器械主文档.docx"} {
		if _, checkErr = readFixtureTx.Exec(ctx, "UPDATE files SET name=$2 WHERE id=$1", qmsFileID, name); checkErr != nil {
			t.Fatal(checkErr)
		}
		var blocked bool
		if checkErr = readFixtureTx.QueryRow(ctx, "SELECT cdw_qms_special_authority_pending($1)", qmsFileID).Scan(&blocked); checkErr != nil || !blocked {
			t.Fatalf("DHF/DMR not recognized as special controlled authority: %q %v", name, checkErr)
		}
		if checkErr = fixtureReader.cdwFormalValidateClass(ctx, qmsFileID, "qms_verified", issued.ID); !errors.Is(checkErr, domain.ErrPolicyAuthorityPending) {
			t.Fatalf("generic QMS authority wrongly unlocked DHF/DMR: %q %v", name, checkErr)
		}
	}
	if _, checkErr = readFixtureTx.Exec(ctx, "ROLLBACK TO SAVEPOINT cdw_special_qms_77a"); checkErr != nil {
		t.Fatal(checkErr)
	}
	if _, checkErr := readFixtureTx.Exec(ctx, "SAVEPOINT cdw_qms_generic_bypass"); checkErr != nil {
		t.Fatal(checkErr)
	}
	if _, checkErr := readFixtureTx.Exec(ctx, `INSERT INTO cdw_formal_approval_instances
 (id,subject_id,template_version_id,state,requested_by)
 VALUES($1,$2,$3,'pending',$4)`, prefix+"_qms_bypass_attempt", qmsSubjectID, tpl.ID, admin.ID); checkErr == nil {
		t.Fatal("database allowed bypassing QMS control by selecting generic template")
	}
	if _, checkErr := readFixtureTx.Exec(ctx, "ROLLBACK TO SAVEPOINT cdw_qms_generic_bypass"); checkErr != nil {
		t.Fatal(checkErr)
	}
	if _, checkErr := fixtureReader.CDWGrantFormalApprover(ctx, prefix+"_qms_without_appointment", bob.ID, qmsFileID,
		admin.ID, issued.ID); !errors.Is(checkErr, domain.ErrQMSAppointmentPending) {
		t.Fatalf("technical role unexpectedly substituted for a verified QMS appointment: %v", checkErr)
	}
	appointmentID := prefix + "_qms_appointment_01"
	appointment, checkErr := fixtureReader.CDWQMSProposeAppointment(ctx, appointmentID, qmsFileID, bob.ID,
		"management_representative", issued.ID, issued.ID, admin.ID, time.Now().Add(24*time.Hour),
		"隔离测试岗位材料登记，此条不证明现实中的正式企业任命和法规资格。")
	if checkErr != nil || appointment.Status != "pending" {
		t.Fatalf("QMS appointment staging failed %+v %v", appointment, checkErr)
	}
	if _, checkErr = fixtureReader.cdwCurrentQMSAppointment(ctx, qmsFileID, bob.ID,
		"management_representative", issued.ID); !errors.Is(checkErr, domain.ErrQMSAppointmentPending) {
		t.Fatalf("pending QMS appointment was treated as verified: %v", checkErr)
	}
	reviews, checkErr := fixtureReader.CDWQMSPendingReview(ctx, charlie.ID, 100)
	if checkErr != nil || len(reviews) != 1 || reviews[0].ID != appointmentID {
		t.Fatalf("independent document-control queue missing pending assignment: %+v %v", reviews, checkErr)
	}
	selfReviews, checkErr := fixtureReader.CDWQMSPendingReview(ctx, bob.ID, 100)
	if checkErr != nil || len(selfReviews) != 0 {
		t.Fatalf("appointment nominee observed restricted verifier inbox: %+v %v", selfReviews, checkErr)
	}
	selfReviews, checkErr = fixtureReader.CDWQMSPendingReview(ctx, admin.ID, 100)
	if checkErr != nil || len(selfReviews) != 0 {
		t.Fatalf("appointment proposer observed restricted verifier inbox: %+v %v", selfReviews, checkErr)
	}
	if _, checkErr = fixtureReader.CDWQMSVerifyAppointment(ctx, appointmentID, admin.ID,
		"提出任命者不能独立验证自己的任命材料，该操作必须拒绝执行。"); !errors.Is(checkErr, domain.ErrForbidden) {
		t.Fatalf("proposer self-verified QMS appointment: %v", checkErr)
	}
	if _, checkErr = fixtureReader.CDWQMSVerifyAppointment(ctx, appointmentID, bob.ID,
		"被任命人不能自行验证其岗位任命材料，需要另外的有权文控人员。"); !errors.Is(checkErr, domain.ErrForbidden) {
		t.Fatalf("appointed signer self-verified QMS appointment: %v", checkErr)
	}
	appointment, checkErr = fixtureReader.CDWQMSVerifyAppointment(ctx, appointmentID, charlie.ID,
		"隔离场景由独立文控角色核验签批岗位、适用文件、期限及受控原件。")
	if checkErr != nil || appointment.Status != "verified" || appointment.VerifiedBy != charlie.ID {
		t.Fatalf("valid independent QMS appointment verification failed %+v %v", appointment, checkErr)
	}
	reviews, checkErr = fixtureReader.CDWQMSPendingReview(ctx, charlie.ID, 100)
	if checkErr != nil || len(reviews) != 1 || reviews[0].Status != "verified" {
		t.Fatalf("non-admin document controller cannot reopen verified appointment for later revocation: %+v %v", reviews, checkErr)
	}
	if _, checkErr = fixtureReader.cdwCurrentQMSAppointment(ctx, qmsFileID, bob.ID,
		"general_manager", issued.ID); !errors.Is(checkErr, domain.ErrQMSAppointmentPending) {
		t.Fatalf("QMS appointment role scope not checked: %v", checkErr)
	}
	if _, checkErr = fixtureReader.cdwCurrentQMSAppointment(ctx, qmsFileID, bob.ID,
		"management_representative", issued.ID); checkErr != nil {
		t.Fatalf("verified current QMS appointment was not usable: %v", checkErr)
	}
	if _, checkErr = fixtureReader.CDWGrantFormalApprover(ctx, prefix+"_qms_role", bob.ID, qmsFileID,
		admin.ID, issued.ID); checkErr != nil {
		t.Fatalf("QMS role did not honor independent appointment: %v", checkErr)
	}
	if _, checkErr = readFixtureTx.Exec(ctx, "SAVEPOINT cdw_qms_appointment_immutable"); checkErr != nil {
		t.Fatal(checkErr)
	}
	if _, checkErr = readFixtureTx.Exec(ctx, `UPDATE cdw_qms_appointments
 SET verified_by=$2 WHERE id=$1`, appointmentID, admin.ID); checkErr == nil {
		t.Fatal("database rewrote an independently verified QMS appointment")
	}
	if _, checkErr = readFixtureTx.Exec(ctx, "ROLLBACK TO SAVEPOINT cdw_qms_appointment_immutable"); checkErr != nil {
		t.Fatal(checkErr)
	}
	if _, checkErr = readFixtureTx.Exec(ctx, "SAVEPOINT cdw_qms_direct_decision"); checkErr != nil {
		t.Fatal(checkErr)
	}
	qmsAttemptID := prefix + "_qms_direct_approval"
	qmsStepID := prefix + "_qms_direct_step"
	if _, checkErr = readFixtureTx.Exec(ctx, `INSERT INTO cdw_formal_approval_instances
 (id,subject_id,template_version_id,state,requested_by)
 VALUES($1,$2,$3,'pending',$4)`, qmsAttemptID, qmsSubjectID, prefix+"_qms_tpl", admin.ID); checkErr != nil {
		t.Fatal(checkErr)
	}
	if _, checkErr = readFixtureTx.Exec(ctx, `INSERT INTO cdw_formal_approval_steps
 (id,instance_id,node_key,sequence_no,approver_user_id,state)
 VALUES($1,$2,'general_manager',1,$3,'ready')`, qmsStepID, qmsAttemptID, charlie.ID); checkErr != nil {
		t.Fatal(checkErr)
	}
	if _, checkErr = readFixtureTx.Exec(ctx, `INSERT INTO cdw_formal_approval_decisions
 (id,step_id,actor_id,decision,reason,subject_sha256,actor_authority_snapshot)
 VALUES($1,$2,$3,'approve','illegal direct approval',$4,'{}'::jsonb)`,
		prefix+"_qms_direct_signature", qmsStepID, charlie.ID, sha); checkErr == nil {
		t.Fatal("direct SQL allowed QMS signature without an exact verified appointment")
	}
	if _, checkErr = readFixtureTx.Exec(ctx, "ROLLBACK TO SAVEPOINT cdw_qms_direct_decision"); checkErr != nil {
		t.Fatal(checkErr)
	}
	if source, checkErr := fixtureReader.CDWQMSAppointmentEvidenceSource(ctx, appointmentID); checkErr != nil || source.SHA256 != sha || source.ReleaseID != issued.ID {
		t.Fatalf("exact effective evidence is not SHA/release-bound: %+v %v", source, checkErr)
	}
	if _, checkErr = readFixtureTx.Exec(ctx, "SAVEPOINT cdw_qms_revocation_test"); checkErr != nil {
		t.Fatal(checkErr)
	}
	if _, checkErr = fixtureReader.CDWQMSRevokeAppointment(ctx, appointmentID, admin.ID,
		"隔离测试：提报人不具有自己撤销任命的独立文控资格，需要拒绝。"); !errors.Is(checkErr, domain.ErrForbidden) {
		t.Fatalf("appointment proposer could revoke: %v", checkErr)
	}
	if _, checkErr = fixtureReader.CDWQMSRevokeAppointment(ctx, appointmentID, bob.ID,
		"隔离测试：被任命人不可绕过岗位撤销职责自行执行撤销。"); !errors.Is(checkErr, domain.ErrForbidden) {
		t.Fatalf("appointed person could revoke: %v", checkErr)
	}
	if revoked, checkErr := fixtureReader.CDWQMSRevokeAppointment(ctx, appointmentID, charlie.ID,
		"隔离测试：任命依据经独立文控确认失效，立即撤销后续签批权限并保留历史。"); checkErr != nil || revoked.Status != "revoked" {
		t.Fatalf("authorized QMS appointment revocation failed %+v %v", revoked, checkErr)
	}
	if _, checkErr = fixtureReader.cdwCurrentQMSAppointment(ctx, qmsFileID, bob.ID,
		"management_representative", issued.ID); !errors.Is(checkErr, domain.ErrQMSAppointmentPending) {
		t.Fatalf("revoked appointment still authorizes QMS signature: %v", checkErr)
	}
	alerts, checkErr := fixtureReader.CDWQMSAppointmentAlerts(ctx, bob.ID, 50)
	if checkErr != nil || len(alerts) != 1 || alerts[0].AppointmentID != appointmentID || alerts[0].ReadAt != nil {
		t.Fatalf("revocation recipient notice not persisted: %+v %v", alerts, checkErr)
	}
	if ok, checkErr := fixtureReader.CDWQMSReadAppointmentAlert(ctx, alerts[0].ID, charlie.ID); checkErr != nil || ok {
		t.Fatalf("other recipient acknowledged someone else's alert: %t %v", ok, checkErr)
	}
	if ok, checkErr := fixtureReader.CDWQMSReadAppointmentAlert(ctx, alerts[0].ID, bob.ID); checkErr != nil || !ok {
		t.Fatalf("recipient could not acknowledge own alert: %t %v", ok, checkErr)
	}
	if _, checkErr = readFixtureTx.Exec(ctx, "SAVEPOINT cdw_qms_direct_revocation"); checkErr != nil {
		t.Fatal(checkErr)
	}
	if _, checkErr = readFixtureTx.Exec(ctx, `UPDATE cdw_qms_appointments SET status='verified'
 WHERE id=$1`, appointmentID); checkErr == nil {
		t.Fatal("database permitted restoring revoked appointment")
	}
	if _, checkErr = readFixtureTx.Exec(ctx, "ROLLBACK TO SAVEPOINT cdw_qms_direct_revocation"); checkErr != nil {
		t.Fatal(checkErr)
	}
	if _, checkErr = readFixtureTx.Exec(ctx, "ROLLBACK TO SAVEPOINT cdw_qms_revocation_test"); checkErr != nil {
		t.Fatal(checkErr)
	}
	if active, checkErr := fixtureReader.cdwCurrentQMSAppointment(ctx, qmsFileID, bob.ID,
		"management_representative", issued.ID); checkErr != nil || active == "" {
		t.Fatalf("isolated revocation rollback did not restore fixture: %q %v", active, checkErr)
	}
	t.Log("CDW_QMS_REVOCATION_FIXTURE_PASS independent-revoke, immutable-history, signer-blocked, recipient-notices+ack, exact-docx")
	t.Log("CDW_QMS_APPOINTMENT_FIXTURE_PASS pending+no-self+independent-verification+exact-position+no-rewrite")
	if _, checkErr := readFixtureTx.Exec(ctx, "SAVEPOINT cdw_qms_revocation_fixture"); checkErr != nil {
		t.Fatal(checkErr)
	}
	if _, checkErr := readFixtureTx.Exec(ctx, `UPDATE cdw_effective_pointers
 SET state='none',release_id=NULL WHERE file_id=$1`, fileID); checkErr != nil {
		t.Fatal(checkErr)
	}
	if active, checkErr := fixtureReader.cdwQMSPolicyEffective(ctx, issued.ID); checkErr != nil || active {
		t.Fatalf("superseded policy pointer still authorizes QMS: %t %v", active, checkErr)
	}
	if _, checkErr = fixtureReader.cdwCurrentQMSAppointment(ctx, qmsFileID, bob.ID,
		"management_representative", issued.ID); !errors.Is(checkErr, domain.ErrQMSAppointmentPending) {
		t.Fatalf("withdrawn controlled evidence did not invalidate appointment: %v", checkErr)
	}
	if _, checkErr := fixtureReader.CDWPublishFormalTemplate(ctx, prefix+"_qms_tpl_revoked",
		"qms_"+qmsPolicyTemplate+"_revoked", qmsSteps, admin.ID, issued.ID); !errors.Is(checkErr, domain.ErrPolicyAuthorityPending) {
		t.Fatalf("QMS publish was not blocked after policy pointer withdrawal: %v", checkErr)
	}
	if _, checkErr := readFixtureTx.Exec(ctx, "ROLLBACK TO SAVEPOINT cdw_qms_revocation_fixture"); checkErr != nil {
		t.Fatal(checkErr)
	}
	t.Log("CDW_QMS_POLICY_EFFECTIVE_FIXTURE_PASS valid pointer grants, revoked pointer blocks, isolated rollback")
	var scheduleStatusAfterManual string
	if e = readFixtureTx.QueryRow(ctx, `SELECT status FROM cdw_activation_schedules WHERE release_id=$1`, issued.ID).Scan(&scheduleStatusAfterManual); e != nil || scheduleStatusAfterManual != "completed" {
		t.Fatalf("manual activation failed to stop previously enabled timer: %q %v", scheduleStatusAfterManual, e)
	}
	if _, e = fixtureReader.CDWActivateRelease(ctx, prefix+"_activation_replay", issued.ID,
		admin.ID, issued.Revision, prefix+"_g8_activate_again"); !errors.Is(e, domain.ErrVersionConflict) {
		t.Fatalf("duplicate activation bypassed CAS: %v", e)
	}
	// Search is a separate, SHA-bound projection of the true issued artifact.
	// All rows here are rolled back with readFixtureTx, not persisted as a fake
	// searchable business document. No ordinary latest file_text is consulted.
	if _, e = readFixtureTx.Exec(ctx, `INSERT INTO cdw_effective_search_index
	 (release_id,artifact_id,blob_id,sha256,state,lease_token,lease_until)
	 SELECT $1,a.id,a.blob_id,a.sha256,'pending',$2,clock_timestamp()+interval '1 minute'
	 FROM cdw_release_artifacts a WHERE a.release_id=$1 AND a.purpose='distribution' AND a.format='docx'`,
		issued.ID, prefix+"_index_lease"); e != nil {
		t.Fatalf("index fixture setup: %v", e)
	}
	indexJob := ports.CDWEffectiveSearchJob{ReleaseID: issued.ID, BlobID: blobID, SHA256: sha,
		LeaseToken: prefix + "_index_lease"}
	if e = readFixtureTx.QueryRow(ctx, `SELECT artifact_id FROM cdw_effective_search_index
	 WHERE release_id=$1`, issued.ID).Scan(&indexJob.ArtifactID); e != nil {
		t.Fatal(e)
	}
	if e = fixtureReader.CDWFinishEffectiveIndexJob(ctx, indexJob, "current approved search witness", "current approved search witness"); e != nil {
		t.Fatalf("indexed immutable distribution artifact rejected: %v", e)
	}
	indexQuery := ports.FileSearchQuery{UserID: admin.ID, Query: "search witness", TextQuery: "search witness", Limit: 10}
	searchHits, e := fixtureReader.CDWSearchEffectiveCandidates(ctx, indexQuery)
	if e != nil || len(searchHits) != 1 || searchHits[0].FileID != fileID ||
		searchHits[0].ReleaseID != issued.ID || searchHits[0].SHA256 != sha ||
		!strings.Contains(searchHits[0].Snippet, "search witness") {
		t.Fatalf("effective search did not use exact issued digest: %+v %v", searchHits, e)
	}
	indexQuery.UserID = alice.ID
	unauthorizedHits, e := fixtureReader.CDWSearchEffectiveCandidates(ctx, indexQuery)
	if e != nil || len(unauthorizedHits) != 0 {
		t.Fatalf("ungranted user observed controlled search hit: %+v %v", unauthorizedHits, e)
	}
	indexQuery.UserID = admin.ID
	indexQuery.Query = "ordinary-latest"
	indexQuery.TextQuery = "ordinary-latest"
	ordinaryHits, e := fixtureReader.CDWSearchEffectiveCandidates(ctx, indexQuery)
	if e != nil || len(ordinaryHits) != 0 {
		t.Fatalf("ordinary latest content leaked into immutable search: %+v %v", ordinaryHits, e)
	}
	indexQuery.Query = "search witness"
	indexQuery.TextQuery = "search witness"
	if _, e = readFixtureTx.Exec(ctx, `UPDATE cdw_effective_search_index SET state='retry'
	 WHERE release_id=$1`, issued.ID); e != nil {
		t.Fatal(e)
	}
	unreadyHits, e := fixtureReader.CDWSearchEffectiveCandidates(ctx, indexQuery)
	if e != nil || len(unreadyHits) != 0 {
		t.Fatalf("unready index exposed: %+v %v", unreadyHits, e)
	}
	if _, e = readFixtureTx.Exec(ctx, `UPDATE cdw_effective_search_index SET state='ready'
	 WHERE release_id=$1`, issued.ID); e != nil {
		t.Fatal(e)
	}
	t.Log("CDW_G8_EFFECTIVE_SEARCH_POSTGRES_PASS immutable-sha-content, unauthorized-user, ordinary-latest exclusion, unready exclusion")
	controlledRead, managed, e := fixtureReader.CDWEffectiveRead(ctx, fileID, admin.ID, domain.ActionPreview)
	if e != nil || !managed || controlledRead.BlobID != blobID ||
		controlledRead.SHA256 != sha || controlledRead.FileName == "" {
		t.Fatalf("effective read did not resolve immutable distributed artifact: %+v managed=%t err=%v", controlledRead, managed, e)
	}
	if _, managed, e = fixtureReader.CDWEffectiveRead(ctx, fileID, alice.ID, domain.ActionPreview); !managed || !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("ordinary file access escalated into controlled release read: managed=%t err=%v", managed, e)
	}
	if _, managed, e = fixtureReader.CDWEffectiveRead(ctx, fileID, bob.ID, domain.ActionDownload); !managed || e != nil {
		t.Fatalf("authorized batch recipient denied exact controlled file: managed=%t err=%v", managed, e)
	}
	printedArtifact, managed, e := fixtureReader.CDWEffectiveRead(ctx, fileID, bob.ID, domain.ActionPrint)
	if e != nil || !managed || printedArtifact.BlobID != blobID || printedArtifact.SHA256 != sha ||
		printedArtifact.Format != "docx" {
		t.Fatalf("authorized controlled print did not select issued artifact: %+v managed=%t err=%v",
			printedArtifact, managed, e)
	}
	if _, e = readFixtureTx.Exec(ctx, `UPDATE cdw_release_access_grants SET revoked_at=clock_timestamp()
	 WHERE user_id=$1 AND release_id=$2`, bob.ID, issued.ID); e != nil {
		t.Fatal(e)
	}
	if _, managed, e = fixtureReader.CDWEffectiveRead(ctx, fileID, bob.ID, domain.ActionDownload); !managed || !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("revoked release grant still accessed controlled file: managed=%t err=%v", managed, e)
	}
	if _, managed, e = fixtureReader.CDWEffectiveRead(ctx, fileID, bob.ID, domain.ActionPrint); !managed || !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("revoked release grant still allowed controlled printing: managed=%t err=%v", managed, e)
	}
	if _, e = readFixtureTx.Exec(ctx, `UPDATE cdw_effective_pointers SET state='none',release_id=NULL WHERE file_id=$1`, fileID); e != nil {
		t.Fatal(e)
	}
	withdrawnSearch, e := fixtureReader.CDWSearchEffectiveCandidates(ctx, indexQuery)
	if e != nil || len(withdrawnSearch) != 0 {
		t.Fatalf("nonactive effective pointer leaked historical index: %+v %v", withdrawnSearch, e)
	}
	if _, managed, e = fixtureReader.CDWEffectiveRead(ctx, fileID, admin.ID, domain.ActionPreview); !managed || !errors.Is(e, domain.ErrConflict) {
		t.Fatalf("explicit no-effective-version pointer leaked ordinary latest: managed=%t err=%v", managed, e)
	}
	if e = readFixtureTx.Rollback(ctx); e != nil {
		t.Fatal(e)
	}
	t.Log("CDW_G8_ACTIVATION_POSTGRES_PASS blockers, authorization, immutable effective transaction, duplicate CAS, rollback fixture and fail-closed reads")
	withdrawInput := application.CDWDistributionWithdrawalInput{Reason: "该发行批次发现版本适用范围错误，需撤销此次未生效的部门分发并保留原签收记录。"}
	if _, e = service.CDWWithdrawDistribution(ctx, alice, plan.ID, 4, withdrawInput, prefix+"_g9_withdraw_unprivileged"); !errors.Is(e, domain.ErrForbidden) {
		t.Fatalf("scope reviewer withdrew release without document-control role: %v", e)
	}
	if _, e = service.CDWWithdrawDistribution(ctx, admin, plan.ID, 3, withdrawInput, prefix+"_g9_withdraw_stale"); !errors.Is(e, domain.ErrVersionConflict) {
		t.Fatalf("withdrawal did not enforce plan CAS: %v", e)
	}
	withdrawn, e := service.CDWWithdrawDistribution(ctx, admin, plan.ID, 4, withdrawInput, prefix+"_g9_withdraw")
	if e != nil || withdrawn.State != "withdrawn" || withdrawn.RevokedGrants < 4 ||
		withdrawn.CancelledReaders != 1 || withdrawn.InvalidatedTargets != 2 || withdrawn.ManifestSHA256 != frozenPlan.DigestSHA256 {
		t.Fatalf("atomic batch withdrawal and rights revocation %+v %v", withdrawn, e)
	}
	replayedWithdrawal, e := service.CDWWithdrawDistribution(ctx, admin, plan.ID, 4, withdrawInput, prefix+"_g9_withdraw")
	if e != nil || replayedWithdrawal.ID != withdrawn.ID {
		t.Fatalf("withdrawal replay %+v %v", replayedWithdrawal, e)
	}
	if _, e = service.CDWWithdrawDistribution(ctx, admin, plan.ID, 4, withdrawInput, prefix+"_g9_withdraw_again"); !errors.Is(e, domain.ErrVersionConflict) {
		t.Fatalf("withdrawal second finalization was permitted: %v", e)
	}
	var validAfter string
	if e = pool.QueryRow(ctx, `SELECT state FROM cdw_controlled_releases WHERE id=$1`, issued.ID).Scan(&validAfter); e != nil {
		t.Fatal(e)
	}
	if validAfter != "withdrawn" {
		t.Fatalf("release state should be withdrawn, not %s", validAfter)
	}
	var savedConfirmations, preservedReceipts, unconfirmed int
	if e = pool.QueryRow(ctx, `SELECT COUNT(*) FROM cdw_reading_events WHERE assignment_id=$1 AND kind='confirmed'`, bobAssignment.ID).Scan(&savedConfirmations); e != nil {
		t.Fatal(e)
	}
	if e = pool.QueryRow(ctx, `SELECT COUNT(*) FROM cdw_department_receipts r JOIN cdw_distribution_targets t ON t.id=r.target_id WHERE t.batch_id=$1`, batch.ID).Scan(&preservedReceipts); e != nil {
		t.Fatal(e)
	}
	if e = pool.QueryRow(ctx, `SELECT COUNT(*) FROM cdw_reading_assignments WHERE batch_id=$1 AND state='cancelled'`, batch.ID).Scan(&unconfirmed); e != nil {
		t.Fatal(e)
	}
	if savedConfirmations != 1 || preservedReceipts != 2 || unconfirmed != 1 {
		t.Fatalf("withdrawal lost old evidence: confirmed=%d receipts=%d cancelled=%d", savedConfirmations, preservedReceipts, unconfirmed)
	}
	postWithdrawLedger, e := service.CDWDistributionLedger(ctx, admin, plan.ID)
	if e != nil || postWithdrawLedger.BatchState != "withdrawn" || len(postWithdrawLedger.Rows) != 2 {
		t.Fatalf("withdrawn batch history unavailable: %+v %v", postWithdrawLedger, e)
	}
	if _, e = service.CDWConfirmReading(ctx, charlie, charlieReadID, readingStatement, prefix+"_g9_after_revoke"); !errors.Is(e, domain.ErrConflict) {
		t.Fatalf("withdrawn batch allowed an unexpected confirmation: %v", e)
	}
	t.Logf("CDW_G9_WITHDRAW_POSTGRES_PASS batch=%s revoked=%d cancelled_readers=%d preserved_receipts=2", batch.ID, withdrawn.RevokedGrants, withdrawn.CancelledReaders)
	t.Logf("CDW_G9_LEDGER_POSTGRES_PASS plan=%s departments=2 receipts=2 reading=1/1 roster_missing=1", plan.ID)
	t.Logf("CDW_G9_READING_POSTGRES_PASS roster=%s assignment=%s single_confirmed_event=1", bobRoster.ID, bobAssignment.ID)
	t.Logf("CDW_G9_SCOPE_APPROVED_POSTGRES_PASS plan=%s digest=%s batch=none", plan.ID, approvedPlan.DigestSHA256)
	t.Logf("CDW_G9_SCOPE_FROZEN_POSTGRES_PASS plan=%s departments=2 digest=%s issued=none", plan.ID, frozenPlan.DigestSHA256)
	t.Logf("CDW_G8_VERIFIED_ARTIFACT_PASS release=%s sha=%s still_not_effective", ready.ID, sha)
	t.Logf("CDW_G8_PREPARE_POSTGRES_PASS release=%s sha=%s active_pointer=none", prepared.ID, sha)
	t.Logf("CDW_G7_FORMAL_POSTGRES_PASS subject=%s candidate=%s sha=%s steps=2", started.SubjectID, final.CandidateID, sha)
}
