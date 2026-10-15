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

func exerciseCDWG6Override(t *testing.T, ctx context.Context, pool *pgxpool.Pool, repo *Repository,
	service *application.Service, prefix string, admin, alice, bob, charlie domain.User, fileID, baseBlobID string) {
	t.Helper()
	// Ordinary templates remain non-substitutable by default.
	var defaultCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM cdw_review_gates WHERE substitutable=true AND
 delivery_id IN (SELECT id FROM cdw_deliveries WHERE task_id IN (SELECT id FROM cdw_tasks
 WHERE template_version_id='cdw_template_single_file_v1'))`).Scan(&defaultCount); err != nil || defaultCount != 0 {
		t.Fatalf("G6 default templates unexpectedly allow override: %d %v", defaultCount, err)
	}
	root, err := service.CDWCreateRootTask(ctx, admin, application.CDWRootTaskInput{
		Title: "G6 override parent A", FileID: fileID, AllowOverrideReview: true,
		Assignee: ports.CDWAssignmentTarget{Kind: "user", ID: alice.ID},
	}, prefix+"_g6root")
	if err != nil {
		t.Fatal("g6 root:", err)
	}
	if _, err = service.CDWAcceptTask(ctx, alice, root.TaskID, 1, prefix+"_g6root_accept"); err != nil {
		t.Fatal(err)
	}
	middle, err := service.CDWDelegateTask(ctx, alice, root.TaskID, application.CDWChildTaskInput{
		Title: "G6 B middle", Assignee: ports.CDWAssignmentTarget{Kind: "user", ID: bob.ID},
	}, 2, prefix+"_g6delegate_B")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.CDWAcceptTask(ctx, bob, middle.TaskID, 1, prefix+"_g6accept_B"); err != nil {
		t.Fatal(err)
	}
	leaf, err := service.CDWDelegateTask(ctx, bob, middle.TaskID, application.CDWChildTaskInput{
		Title: "G6 C leaf", Assignee: ports.CDWAssignmentTarget{Kind: "user", ID: charlie.ID},
	}, 2, prefix+"_g6delegate_C")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.CDWAcceptTask(ctx, charlie, leaf.TaskID, 1, prefix+"_g6accept_C"); err != nil {
		t.Fatal(err)
	}
	branch, err := service.CDWCreateBranch(ctx, charlie, leaf.TaskID, prefix+"_g6branch")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := repo.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	store := tx.(ports.CDWBranchStore)
	session, err := store.CDWOpenBranchSession(ctx, branch.ID, charlie.ID, application.NewID("cdwos"), application.NewID("cdwkey"), time.Now().Add(30*time.Minute))
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	req, err := service.CDWRequestBranchSave(ctx, charlie, branch.ID, session.ID, prefix+"_g6save")
	if err != nil || req.State != "requested" {
		t.Fatalf("G6 save request: %+v %v", req, err)
	}
	savedBlobID := application.NewID("g6blob")
	savedSHA := strings.Repeat("d", 64)
	if _, err = pool.Exec(ctx, `INSERT INTO blobs(id,storage_key,sha256,size_bytes,state)
 VALUES($1,$2,$3,42,'ready')`, savedBlobID, prefix+"_g6_payload", savedSHA); err != nil {
		t.Fatal(err)
	}
	persist, err := repo.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	revision := application.NewID("cdwrev")
	applied, err := persist.(ports.CDWBranchStore).CDWCommitBranchCallback(ctx, session.DocumentKey, 6, req.ID,
		strings.Repeat("9", 64), savedBlobID, 42, savedSHA, 1, revision)
	if err != nil || !applied {
		_ = persist.Rollback(ctx)
		t.Fatalf("G6 callback: %v %v", applied, err)
	}
	if err = persist.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	freeze, err := service.CDWFreezeBranch(ctx, charlie, branch.ID, req.ID, revision, 2, prefix+"_g6freeze")
	if err != nil {
		t.Fatal("G6 freeze:", err)
	}
	gate, err := service.CDWReviewGate(ctx, bob, freeze.ReviewGateID)
	if err != nil || !gate.Substitutable || gate.ReviewerID != bob.ID {
		t.Fatalf("opt-in gate: %+v %v", gate, err)
	}
	if _, err = service.CDWGrantReview(ctx, admin, gate.ID, alice.ID, "administrator may not issue for B", 1, prefix+"_g6admin_grant"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("admin bypass granted: %v", err)
	}
	if _, err = service.CDWGrantReview(ctx, bob, gate.ID, charlie.ID, "executor may not override", 1, prefix+"_g6descendant"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("grant to task executor accepted: %v", err)
	}
	candidates, err := service.CDWReviewCandidates(ctx, bob, gate.ID)
	if err != nil || len(candidates) != 1 || candidates[0].ID != alice.ID {
		t.Fatalf("wrong ancestors: %+v %v", candidates, err)
	}
	grant, err := service.CDWGrantReview(ctx, bob, gate.ID, alice.ID, "A 代验收 C 的专项测试", 1, prefix+"_g6grant")
	if err != nil || grant.ID == "" {
		t.Fatalf("grant issuance: %+v %v", grant, err)
	}
	if duplicate, ee := service.CDWGrantReview(ctx, bob, gate.ID, alice.ID, "A 代验收 C 的专项测试", 1, prefix+"_g6grant"); ee != nil || duplicate.ID != grant.ID {
		t.Fatalf("grant replay: %+v %v", duplicate, ee)
	}
	if _, ee := service.CDWGrantReview(ctx, bob, gate.ID, alice.ID, "different active grant", 1, prefix+"_g6_duplicate_active"); !errors.Is(ee, domain.ErrConflict) {
		t.Fatalf("duplicate active delegation not bounded: %v", ee)
	}
	inbox, err := service.CDWReviewInbox(ctx, alice, 30)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, g := range inbox {
		if g.ID == gate.ID && g.ReviewMode == "delegated" && g.OverrideGrantID == grant.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("delegated inbox omitted gate: %+v", inbox)
	}
	if _, err = service.CDWDecideReview(ctx, alice, gate.ID, "accept", "", 1, prefix+"_g6_bypass"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("override without explicit grant ID accepted: %v", err)
	}
	revoked, err := service.CDWRevokeReviewGrant(ctx, bob, gate.ID, grant.ID, prefix+"_g6revoke")
	if err != nil || !revoked.Revoked {
		t.Fatalf("revoke: %+v %v", revoked, err)
	}
	if _, err = service.CDWDecideReview(ctx, alice, gate.ID, "accept", "", 1, prefix+"_g6revoked_review", grant.ID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("revoked grant accepted: %v", err)
	}
	grant2, err := service.CDWGrantReview(ctx, bob, gate.ID, alice.ID, "短期授权失效测试", 1, prefix+"_g6grant2")
	if err != nil {
		t.Fatal(err)
	}
	// Use a valid but historical validity interval; no clock manipulation and
	// no mutation of the business application database.
	if _, err = pool.Exec(ctx, `UPDATE cdw_override_grants SET valid_from=now()-interval '3 days',expires_at=now()-interval '1 day'
 WHERE id=$1`, grant2.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = service.CDWDecideReview(ctx, alice, gate.ID, "accept", "", 1, prefix+"_g6expired_review", grant2.ID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("expired grant accepted: %v", err)
	}
	if _, err = service.CDWRevokeReviewGrant(ctx, bob, gate.ID, grant2.ID, prefix+"_g6revoke2"); err != nil {
		t.Fatal(err)
	}
	grant3, err := service.CDWGrantReview(ctx, bob, gate.ID, alice.ID, "允许 A 代 B 验收 C 当前冻结交付", 1, prefix+"_g6grant3")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.CDWDecideReview(ctx, charlie, gate.ID, "return", "错误目标", 1, prefix+"_g6outsider", grant3.ID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("unbound executor used another actor grant: %v", err)
	}
	final, err := service.CDWDecideReview(ctx, alice, gate.ID, "accept", "已核对冻结稿", 1, prefix+"_g6decide", grant3.ID)
	if err != nil || final.State != "substituted" || final.TaskState != "accepted_delivery" || final.ActingForID != bob.ID || final.OverrideGrantID != grant3.ID {
		t.Fatalf("delegated accept failed: %+v %v", final, err)
	}
	// Reusing the exact request key must return the committed delegated
	// decision even though its gate is now terminal and no longer eligible
	// for a NEW authorization check.
	replayDecision, ee := service.CDWDecideReview(ctx, alice, gate.ID, "accept", "已核对冻结稿", 1, prefix+"_g6decide", grant3.ID)
	if ee != nil || replayDecision.OverrideGrantID != final.OverrideGrantID || replayDecision.Revision != final.Revision {
		t.Fatalf("delegated decision idempotent replay failed: %+v %v", replayDecision, ee)
	}
	// Revoking the authorization AFTER the recorded final decision cannot
	// retroactively erase its evidence or break same-key response replay.
	if after, ee := service.CDWRevokeReviewGrant(ctx, bob, gate.ID, grant3.ID, prefix+"_g6revoke_after"); ee != nil || !after.Revoked {
		t.Fatalf("post-decision revocation evidence: %+v %v", after, ee)
	}
	replayAfterRevoke, ee := service.CDWDecideReview(ctx, alice, gate.ID, "accept", "已核对冻结稿", 1, prefix+"_g6decide", grant3.ID)
	if ee != nil || replayAfterRevoke.OverrideGrantID != grant3.ID {
		t.Fatalf("same-key replay after grant revoked: %+v %v", replayAfterRevoke, ee)
	}
	if other, ee := service.CDWDecideReview(ctx, bob, gate.ID, "return", "第二次审核不允许", 2, prefix+"_g6double"); !errors.Is(ee, domain.ErrVersionConflict) {
		t.Fatalf("direct reviewer overrode terminal gate: %+v %v", other, ee)
	}
	var realActor, actingFor, proof string
	if err = pool.QueryRow(ctx, `SELECT actor_id,acting_for_id,override_grant_id FROM cdw_review_decisions
 WHERE gate_id=$1`, gate.ID).Scan(&realActor, &actingFor, &proof); err != nil {
		t.Fatal(err)
	}
	if realActor != alice.ID || actingFor != bob.ID || proof != grant3.ID {
		t.Fatalf("actor impersonated, actor=%s for=%s grant=%s", realActor, actingFor, proof)
	}
	var pending int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM cdw_accountability_obligations
 WHERE task_id IN ($1,$2) AND state='pending'`, middle.TaskID, leaf.TaskID).Scan(&pending); err != nil || pending != 6 {
		t.Fatalf("override waived middle obligations %d %v", pending, err)
	}
	var formal int
	if err = pool.QueryRow(ctx, `SELECT current_version_seq FROM files WHERE id=$1`, fileID).Scan(&formal); err != nil || formal != 1 {
		t.Fatalf("override affected formal file version %d %v", formal, err)
	}
	_ = baseBlobID
	t.Logf("CDW_G6_OVERRIDE_POSTGRES_PASS task=%s actor=%s acting_for=%s grant=%s pending_obligations=%d", leaf.TaskID, realActor, actingFor, proof, pending)
}
