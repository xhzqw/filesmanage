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
	t.Logf("CDW_G8_VERIFIED_ARTIFACT_PASS release=%s sha=%s still_not_effective", ready.ID, sha)
	t.Logf("CDW_G8_PREPARE_POSTGRES_PASS release=%s sha=%s active_pointer=none", prepared.ID, sha)
	t.Logf("CDW_G7_FORMAL_POSTGRES_PASS subject=%s candidate=%s sha=%s steps=2", started.SubjectID, final.CandidateID, sha)
}
