package postgres_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"

	"filesmanage/internal/adapter/blob"
	"filesmanage/internal/adapter/postgres"
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"filesmanage/internal/domain/dhf"
	"filesmanage/internal/ports"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

// Opt-in ONLY: run after applying ALL migrations to a fresh isolated database.
// Database-name check prevents accidentally writing into a business database.
func TestDHFPilotRealPostgresSubmission(t *testing.T) {
	dsn := os.Getenv("DHF_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("isolated DHF integration database not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var dbName string
	if err = pool.QueryRow(ctx, "SELECT current_database()").Scan(&dbName); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(dbName, "filesmanage_dhf_v063_integration_") {
		t.Fatalf("refusing DHF integration test against non-isolated database %q", dbName)
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("setup SQL: %v", err)
		}
	}
	sha := func(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
	actorID := "dhf_v063_test_user"
	exec("INSERT INTO users(id,login,display_name,password_hash) VALUES($1,$1,'DHF Test','not-a-real-password')", actorID)
	exec("INSERT INTO folders(id,name,owner_id) VALUES('dhf_folder','DHF Test', $1)", actorID)
	exec("INSERT INTO acls(id,folder_id,subject_kind,subject_id,actions,granted_by) VALUES('dhf_acl','dhf_folder','user',$1,ARRAY['list','download']::text[],$1)", actorID)
	// Stage REAL content through the production BlobStore. Database metadata
	// alone must never be sufficient for an approved DHF evidence submission.
	physicalStore := blob.New(t.TempDir())
	stage, err := physicalStore.Stage()
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("DHF pilot immutable evidence bytes")
	if _, err = stage.Write(content); err != nil {
		t.Fatal(err)
	}
	storageKey, _, err := stage.Commit()
	if err != nil {
		t.Fatal(err)
	}
	fileSHA := stage.Sha256()
	exec("INSERT INTO blobs(id,storage_key,sha256,size_bytes,state) VALUES('dhf_blob',$1,$2,$3,'ready')", storageKey, fileSHA, len(content))
	exec("INSERT INTO files(id,folder_id,name,uploaded_by) VALUES('dhf_file','dhf_folder','artifact.txt',$1)", actorID)
	exec("INSERT INTO file_versions(id,file_id,seq,blob_id,sha256,size_bytes,action,created_by) VALUES('dhf_v1','dhf_file',1,'dhf_blob',$1,$2,'upload',$3)", fileSHA, len(content), actorID)
	// Match the real upload lifecycle: current pointer is set only after the
	// immutable version exists, otherwise fileSelect sees NULL version fields.
	exec("UPDATE files SET current_version_seq=1 WHERE id='dhf_file'")
	policyBytes, err := json.Marshal(map[string]any{
		"stage_id": "G1", "conditional_allowed": false,
		"requirements": []dhf.RequirementPolicy{{ID: "DHF-REQ-001", Mandatory: true, Critical: true, ConditionEligible: false, AllowNotApplicable: false}},
		"dependencies": []dhf.DependencyPolicy{},
		"specialties":  []dhf.SpecialtyPolicy{},
	})
	if err != nil {
		t.Fatal(err)
	}
	manifestBytes, err := json.Marshal(map[string]any{
		"requirements": []map[string]any{{
			"id": "DHF-REQ-001", "applicability": "applicable",
			"file_id": "dhf_file", "version_seq": 1, "sha256": fileSHA,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	exec("INSERT INTO dhf_pilot_templates(id,stage_id,policy_body,policy_sha,status,approved_by,approved_at) VALUES('dhf_tpl','G1',$1,$2,'published',$3,now())", policyBytes, sha(policyBytes), actorID)
	exec("INSERT INTO dhf_pilot_projects(id,owner_id,state) VALUES('dhf_project',$1,'active')", actorID)
	exec("INSERT INTO dhf_pilot_baselines(project_id,stage_id,template_id,active) VALUES('dhf_project','G1','dhf_tpl',true)")
	exec("INSERT INTO dhf_pilot_members(project_id,user_id,can_prepare,can_submit) VALUES('dhf_project',$1,true,true)", actorID)
	seedAttempt := func(id string) {
		t.Helper()
		exec("INSERT INTO dhf_pilot_attempts(id,project_id,stage_id,template_id,manifest_body,manifest_sha,created_by) VALUES($1,'dhf_project','G1','dhf_tpl',$2,$3,$4)", id, manifestBytes, sha(manifestBytes), actorID)
	}
	seedAttempt("dhf_attempt_1")
	service := application.New(postgres.New(pool), dhfTestBlobAdapter{Store: physicalStore})
	actor := domain.User{ID: actorID, IsAdmin: true} // caller flag intentionally untrusted
	first, err := service.DHFPilotSubmit(ctx, actor, "dhf_attempt_1", "dhf-isolated-idempotency-0001")
	if err != nil || first.Verdict != dhf.Allow || first.Replayed || first.SubmissionID == "" {
		t.Fatalf("first DB submission denied: %+v error=%v", first, err)
	}
	retry, err := service.DHFPilotSubmit(ctx, actor, "dhf_attempt_1", "dhf-isolated-idempotency-0001")
	if err != nil || !retry.Replayed || retry.SubmissionID != first.SubmissionID {
		t.Fatalf("DB idempotent retry: %+v error=%v", retry, err)
	}
	different, err := service.DHFPilotSubmit(ctx, actor, "dhf_attempt_1", "dhf-isolated-idempotency-0002")
	if err != nil || different.Verdict != dhf.Deny {
		t.Fatalf("different key reused: %+v %v", different, err)
	}
	var state string
	var count int
	err = pool.QueryRow(ctx, "SELECT state FROM dhf_pilot_attempts WHERE id='dhf_attempt_1'").Scan(&state)
	if err != nil || state != "submitted" {
		t.Fatalf("attempt state %q: %v", state, err)
	}
	for _, query := range []string{
		"SELECT count(*) FROM dhf_pilot_submissions WHERE attempt_id='dhf_attempt_1'",
		"SELECT count(*) FROM dhf_pilot_submission_evidence WHERE submission_id=$1 AND file_id='dhf_file' AND version_seq=1 AND sha256=$2",
		"SELECT count(*) FROM audit_events WHERE event_type='dhf.pilot.submitted' AND target_id='dhf_attempt_1'",
	} {
		if strings.Contains(query, "$1") {
			err = pool.QueryRow(ctx, query, first.SubmissionID, fileSHA).Scan(&count)
		} else {
			err = pool.QueryRow(ctx, query).Scan(&count)
		}
		if err != nil || count != 1 {
			t.Fatalf("expected one persisted journal/hold/audit: %s -> %d %v", query, count, err)
		}
	}
	// Competing SERIALIZABLE submissions for the SAME attempt must commit
	// exactly once. Other contenders may see a serialization conflict or a
	// replay, but can never create a second journal/evidence/audit record.
	seedAttempt("dhf_attempt_race")
	const contenders = 6
	type raceResult struct {
		outcome application.DHFPilotSubmitOutcome
		err     error
	}
	barrier := make(chan struct{})
	results := make(chan raceResult, contenders)
	var wg sync.WaitGroup
	for i := 0; i < contenders; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-barrier
			got, submitErr := service.DHFPilotSubmit(ctx, actor, "dhf_attempt_race", "dhf-isolated-concurrent-0001")
			results <- raceResult{outcome: got, err: submitErr}
		}()
	}
	close(barrier)
	wg.Wait()
	close(results)
	uniqueWriters := 0
	for result := range results {
		if result.err == nil && result.outcome.Verdict == dhf.Allow && !result.outcome.Replayed {
			uniqueWriters++
		}
	}
	if uniqueWriters != 1 {
		t.Fatalf("concurrent writers=%d, require exactly one", uniqueWriters)
	}
	for _, query := range []string{
		"SELECT count(*) FROM dhf_pilot_submissions WHERE attempt_id='dhf_attempt_race'",
		"SELECT count(*) FROM audit_events WHERE event_type='dhf.pilot.submitted' AND target_id='dhf_attempt_race'",
		"SELECT count(*) FROM dhf_pilot_submission_evidence e JOIN dhf_pilot_submissions s ON s.id=e.submission_id WHERE s.attempt_id='dhf_attempt_race'",
	} {
		if err = pool.QueryRow(ctx, query).Scan(&count); err != nil || count != 1 {
			t.Fatalf("concurrent submit duplicate journal/audit/evidence %q: %d %v", query, count, err)
		}
	}
	eventual, err := service.DHFPilotSubmit(ctx, actor, "dhf_attempt_race", "dhf-isolated-concurrent-0001")
	if err != nil || eventual.Verdict != dhf.Allow || !eventual.Replayed {
		t.Fatalf("eventual exact replay must recover committed result: %+v %v", eventual, err)
	}
	// Submitted G5 evidence must create distinct professional + stage-Gate
	// review tasks in the EXISTING Workbench, assigned only by explicit
	// reviewer configuration, never inherited from global admin privileges.
	for _, reviewer := range []string{"dhf_sw_reviewer", "dhf_mf_reviewer", "dhf_gate_reviewer"} {
		exec("INSERT INTO users(id,login,display_name,password_hash) VALUES($1,$1,$1,'not-a-real-password')", reviewer)
		exec("INSERT INTO dhf_pilot_members(project_id,user_id) VALUES('dhf_project',$1)", reviewer)
	}
	g5Policy, err := json.Marshal(map[string]any{
		"stage_id": "G5", "conditional_allowed": false,
		"requirements": []dhf.RequirementPolicy{
			{ID: "REQ-G5-SW", SpecialtyKey: "G5-SW", Mandatory: true, Critical: true},
			{ID: "REQ-G5-MF", SpecialtyKey: "G5-MF", Mandatory: true, Critical: true},
		},
		"dependencies": []dhf.DependencyPolicy{},
		"specialties":  []dhf.SpecialtyPolicy{{Key: "G5-SW"}, {Key: "G5-MF"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	g5Manifest, err := json.Marshal(map[string]any{"requirements": []map[string]any{
		{"id": "REQ-G5-SW", "applicability": "applicable", "file_id": "dhf_file", "version_seq": 1, "sha256": fileSHA},
		{"id": "REQ-G5-MF", "applicability": "applicable", "file_id": "dhf_file", "version_seq": 1, "sha256": fileSHA},
	}})
	if err != nil {
		t.Fatal(err)
	}
	exec("INSERT INTO dhf_pilot_templates(id,stage_id,policy_body,policy_sha,status,approved_by,approved_at) VALUES('dhf_g5_tpl','G5',$1,$2,'published',$3,now())", g5Policy, sha(g5Policy), actorID)
	exec("INSERT INTO dhf_pilot_baselines(project_id,stage_id,template_id,active) VALUES('dhf_project','G5','dhf_g5_tpl',true)")
	for _, a := range [][2]string{{"G5-SW", "dhf_sw_reviewer"}, {"G5-MF", "dhf_mf_reviewer"}, {"__gate__", "dhf_gate_reviewer"}} {
		exec("INSERT INTO dhf_pilot_review_assignments(project_id,stage_id,review_key,reviewer_id,configured_by) VALUES('dhf_project','G5',$1,$2,$3)", a[0], a[1], actorID)
	}
	seedG5 := func(id string) {
		t.Helper()
		exec("INSERT INTO dhf_pilot_attempts(id,project_id,stage_id,template_id,manifest_body,manifest_sha,created_by) VALUES($1,'dhf_project','G5','dhf_g5_tpl',$2,$3,$4)", id, g5Manifest, sha(g5Manifest), actorID)
	}
	seedG5("dhf_g5_attempt")
	g5Result, g5Err := service.DHFPilotSubmit(ctx, actor, "dhf_g5_attempt", "dhf-g5-reviewed-0001")
	if g5Err != nil || g5Result.Verdict != dhf.Allow {
		t.Fatalf("G5 submit denied: %+v %v", g5Result, g5Err)
	}
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM dhf_pilot_workbench_tasks WHERE submission_id=$1", g5Result.SubmissionID).Scan(&count); err != nil || count != 3 {
		t.Fatalf("expected two specialties + total Gate: %d %v", count, err)
	}
	for _, tc := range [][2]string{{"G5-SW", "dhf_sw_reviewer"}, {"G5-MF", "dhf_mf_reviewer"}, {"__gate__", "dhf_gate_reviewer"}} {
		if err = pool.QueryRow(ctx, "SELECT count(*) FROM dhf_pilot_workbench_tasks WHERE submission_id=$1 AND review_key=$2 AND reviewer_id=$3", g5Result.SubmissionID, tc[0], tc[1]).Scan(&count); err != nil || count != 1 {
			t.Fatalf("missing G5 reviewer %s: %d %v", tc[0], count, err)
		}
	}
	inbox, inboxErr := service.DHFPilotWorkbenchInbox(ctx, domain.User{ID: "dhf_sw_reviewer"})
	if inboxErr != nil || len(inbox) != 1 || inbox[0].ReviewKey != "G5-SW" || inbox[0].SubmissionID != g5Result.SubmissionID {
		t.Fatalf("wrong specialty inbox: %+v %v", inbox, inboxErr)
	}
	otherInbox, inboxErr := service.DHFPilotWorkbenchInbox(ctx, domain.User{ID: "dhf_mf_reviewer"})
	if inboxErr != nil || len(otherInbox) != 1 || otherInbox[0].ReviewKey != "G5-MF" {
		t.Fatalf("G5 tasks leaked across assignees: %+v %v", otherInbox, inboxErr)
	}
	// Reviewer opinions are *trial-only*, unique and attached to exact
	// submitted evidence. G5 total Gate cannot recommend pass until all
	// required specialty reviews are actually recorded.
	var swTask, mfTask, gateTask string
	for _, entry := range []struct {
		key string
		dst *string
	}{
		{"G5-SW", &swTask}, {"G5-MF", &mfTask}, {"__gate__", &gateTask},
	} {
		if err = pool.QueryRow(ctx, "SELECT id FROM dhf_pilot_workbench_tasks WHERE submission_id=$1 AND review_key=$2",
			g5Result.SubmissionID, entry.key).Scan(entry.dst); err != nil {
			t.Fatal(err)
		}
	}
	// A reviewer assignment NEVER grants file read rights by itself.
	// Grant preview explicitly, then prove the preview remains pinned to v1
	// even after the Finder current-version pointer advances to v2.
	_, noACL := service.DHFPilotReviewerEvidence(ctx, domain.User{ID: "dhf_sw_reviewer"}, swTask)
	if noACL == nil {
		t.Fatal("DHF review task leaked file metadata without preview ACL")
	}
	exec("INSERT INTO acls(id,folder_id,subject_kind,subject_id,actions,granted_by) VALUES('dhf_sw_file_preview','dhf_folder','user','dhf_sw_reviewer',ARRAY['list','preview']::text[],$1)", actorID)
	items, evidenceErr := service.DHFPilotReviewerEvidence(ctx, domain.User{ID: "dhf_sw_reviewer"}, swTask)
	if evidenceErr != nil || len(items) != 2 || items[0].VersionSeq != 1 || items[0].Sha256 != fileSHA {
		t.Fatalf("reviewer must see exact frozen v1 metadata after ACL: %+v %v", items, evidenceErr)
	}
	_, nonAssigneeErr := service.DHFPilotReviewerEvidence(ctx, actor, swTask)
	if nonAssigneeErr == nil {
		t.Fatal("project submitter read another reviewer's evidence through task ID")
	}
	newContent := []byte("a different later file version")
	nextStage, nextErr := physicalStore.Stage()
	if nextErr != nil {
		t.Fatal(nextErr)
	}
	if _, nextErr = nextStage.Write(newContent); nextErr != nil {
		t.Fatal(nextErr)
	}
	nextStorageKey, _, nextErr := nextStage.Commit()
	if nextErr != nil {
		t.Fatal(nextErr)
	}
	nextSHA := sha(newContent)
	exec("INSERT INTO blobs(id,storage_key,sha256,size_bytes,state) VALUES('dhf_blob_v2',$1,$2,$3,'ready')",
		nextStorageKey, nextSHA, len(newContent))
	exec("INSERT INTO file_versions(id,file_id,seq,blob_id,sha256,size_bytes,action,created_by) VALUES('dhf_v2','dhf_file',2,'dhf_blob_v2',$1,$2,'edit',$3)",
		nextSHA, len(newContent), actorID)
	exec("UPDATE files SET current_version_seq=2 WHERE id='dhf_file'")
	previewV1, previewErr := service.DHFPilotReviewerEvidencePreview(ctx, domain.User{ID: "dhf_sw_reviewer"},
		swTask, "REQ-G5-SW")
	if previewErr != nil || previewV1.Sha256 != fileSHA || !strings.Contains(previewV1.Content, string(content)) {
		t.Fatalf("DHF frozen preview silently followed mutable current version: %+v %v", previewV1, previewErr)
	}
	_, previewDenied := service.DHFPilotReviewerEvidencePreview(ctx, domain.User{ID: "dhf_mf_reviewer"}, mfTask, "REQ-G5-MF")
	if previewDenied == nil {
		t.Fatal("reviewer without original file preview ACL received bytes")
	}
	early, earlyErr := service.DHFPilotRecommend(ctx, domain.User{ID: "dhf_gate_reviewer"},
		gateTask, "recommend_pass", "", "dhf-g5-gate-before-specialties")
	if earlyErr == nil || early.Reason != "DHF_REVIEW_CONFLICT" {
		t.Fatalf("premature G5 Gate recommendation was accepted: %+v %v", early, earlyErr)
	}
	unauthorized, unauthorizedErr := service.DHFPilotRecommend(ctx, actor, swTask,
		"recommend_pass", "", "dhf-g5-review-unauthorized")
	if unauthorizedErr != nil || unauthorized.Reason != "DHF_SCOPE_DENIED" {
		t.Fatalf("submitter could review own submission: %+v %v", unauthorized, unauthorizedErr)
	}
	// Published G5 specialties are a real immutable responsibility sequence.
	// A later reviewer cannot leapfrog without an intervention from the
	// explicitly assigned final Gate sponsor.
	duties, dutiesErr := service.DHFPilotDutyChain(ctx, domain.User{ID: "dhf_gate_reviewer"})
	if dutiesErr != nil || len(duties) != 3 ||
		duties[0].ReviewKey != "G5-SW" || duties[0].StepOrdinal != 1 ||
		duties[1].ReviewKey != "G5-MF" || duties[1].StepOrdinal != 2 ||
		duties[2].ReviewKey != "__gate__" || duties[2].StepOrdinal != 3 ||
		duties[1].OutstandingPrior != 1 || !duties[1].CanAuthorizeEarly {
		t.Fatalf("DHF responsibility chain not template-ordered: %+v %v", duties, dutiesErr)
	}
	prematureMF, mfEarlyErr := service.DHFPilotRecommend(ctx, domain.User{ID: "dhf_mf_reviewer"}, mfTask,
		"recommend_pass", "manufacturing wants to bypass software", "dhf-mf-before-sw")
	if mfEarlyErr == nil || prematureMF.Reason != "DHF_REVIEW_CONFLICT" {
		t.Fatalf("later specialty proceeded without authorization: %+v %v", prematureMF, mfEarlyErr)
	}
	badSponsor, badSponsorErr := service.DHFPilotAuthorizeEarlyReview(ctx, domain.User{ID: "dhf_sw_reviewer"},
		mfTask, "提前评估制造工艺证据，但软件审核尚未完成", "dhf-wrong-sponsor-0001")
	if badSponsorErr != nil || badSponsor.Reason != "DHF_SCOPE_DENIED" {
		t.Fatalf("unassigned sponsor illegally intervened: %+v %v", badSponsor, badSponsorErr)
	}
	// Direct SQL may not manufacture a sponsor event while omitting the
	// matching audit record. The deferred guard aborts the whole statement.
	var policySHAForIntervention, manifestSHAForIntervention string
	if err = pool.QueryRow(ctx, "SELECT policy_sha,manifest_sha FROM dhf_pilot_submissions WHERE id=$1", g5Result.SubmissionID).
		Scan(&policySHAForIntervention, &manifestSHAForIntervention); err != nil {
		t.Fatal(err)
	}
	if _, forgedErr := pool.Exec(ctx,
		"INSERT INTO dhf_pilot_early_interventions(id,target_task_id,submission_id,authorized_by,reason,idempotency_key,request_sha,policy_sha,manifest_sha) VALUES('dhf-intervention-without-audit',$1,$2,'dhf_gate_reviewer',$3,'dhf-direct-unlogged-0001',repeat('f',64),$4,$5)",
		mfTask, g5Result.SubmissionID, "临时审核可以提前开展，但前序责任不得豁免",
		policySHAForIntervention, manifestSHAForIntervention); forgedErr == nil {
		t.Fatal("intervention must not commit without its matching audit event")
	}
	earlyMF, earlyMFErr := service.DHFPilotAuthorizeEarlyReview(ctx, domain.User{ID: "dhf_gate_reviewer"},
		mfTask, "为了并行评估工艺文件，允许生产审核人先提交意见；软件责任仍须单独完成", "dhf-gate-intervene-mf-0001")
	if earlyMFErr != nil || earlyMF.InterventionID == "" || earlyMF.Replayed {
		t.Fatalf("Gate-sponsored early review not recorded: %+v %v", earlyMF, earlyMFErr)
	}
	earlyReplay, earlyReplayErr := service.DHFPilotAuthorizeEarlyReview(ctx, domain.User{ID: "dhf_gate_reviewer"},
		mfTask, "为了并行评估工艺文件，允许生产审核人先提交意见；软件责任仍须单独完成", "dhf-gate-intervene-mf-0001")
	if earlyReplayErr != nil || !earlyReplay.Replayed || earlyReplay.InterventionID != earlyMF.InterventionID {
		t.Fatalf("intervention retry must reuse identical immutable event: %+v %v", earlyReplay, earlyReplayErr)
	}
	mfOpinion, mfErr := service.DHFPilotRecommend(ctx, domain.User{ID: "dhf_mf_reviewer"}, mfTask,
		"recommend_pass", "manufacturing evidence reviewed early with Gate sponsor", "dhf-g5-mf-recommendation")
	if mfErr != nil || mfOpinion.Status != "reviewed" {
		t.Fatalf("sponsored early review failed: %+v %v", mfOpinion, mfErr)
	}
	withOutstanding, outstandingErr := service.DHFPilotDutyChain(ctx, domain.User{ID: "dhf_gate_reviewer"})
	if outstandingErr != nil || len(withOutstanding) != 3 ||
		withOutstanding[0].Status != "pending" ||
		withOutstanding[1].Status != "reviewed" ||
		withOutstanding[1].OutstandingPrior != 1 ||
		!withOutstanding[1].EarlyIntervention {
		t.Fatalf("early intervention discharged an earlier duty or vanished: %+v %v", withOutstanding, outstandingErr)
	}
	if _, tamper := pool.Exec(ctx, "UPDATE dhf_pilot_review_obligations SET reviewer_id='dhf_gate_reviewer' WHERE task_id=$1", swTask); tamper == nil {
		t.Fatal("immutable original reviewer obligation changed")
	}
	if _, tamper := pool.Exec(ctx, "DELETE FROM dhf_pilot_early_interventions WHERE id=$1", earlyMF.InterventionID); tamper == nil {
		t.Fatal("non-waiver intervention audit event deleted")
	}
	swOpinion, swErr := service.DHFPilotRecommend(ctx, domain.User{ID: "dhf_sw_reviewer"}, swTask,
		"recommend_pass", "software evidence reviewed", "dhf-g5-sw-recommendation")
	if swErr != nil || swOpinion.Status != "reviewed" || swOpinion.DecisionID == "" {
		t.Fatalf("software review did not persist: %+v %v", swOpinion, swErr)
	}
	replayedOpinion, replayedErr := service.DHFPilotRecommend(ctx, domain.User{ID: "dhf_sw_reviewer"}, swTask,
		"recommend_pass", "software evidence reviewed", "dhf-g5-sw-recommendation")
	if replayedErr != nil || !replayedOpinion.Replayed || replayedOpinion.DecisionID != swOpinion.DecisionID {
		t.Fatalf("review idempotent replay failure: %+v %v", replayedOpinion, replayedErr)
	}
	gatePending, pendingErr := service.DHFPilotWorkbenchInbox(ctx, domain.User{ID: "dhf_gate_reviewer"})
	if pendingErr != nil || len(gatePending) != 1 || !gatePending[0].GateReady {
		t.Fatalf("G5 Gate should be ready after all specialties: %+v %v", gatePending, pendingErr)
	}
	gateOpinion, gateErr := service.DHFPilotRecommend(ctx, domain.User{ID: "dhf_gate_reviewer"}, gateTask,
		"recommend_pass", "all specialties reviewed", "dhf-g5-gate-recommendation")
	if gateErr != nil || gateOpinion.Status != "reviewed" {
		t.Fatalf("G5 Gate recommendation failed: %+v %v", gateOpinion, gateErr)
	}
	// V0.7.2: each existing trial decision needs its OWN current password
	// reauthentication. Neither the Gate role nor an early intervention
	// substitutes for missing predecessor authenticated attestations.
	const reviewerPassword = "DHF-v072-test-only-personal-password!"
	passwordHash, hashErr := bcrypt.GenerateFromPassword([]byte(reviewerPassword), bcrypt.MinCost)
	if hashErr != nil {
		t.Fatal(hashErr)
	}
	for _, reviewer := range []string{"dhf_sw_reviewer", "dhf_mf_reviewer", "dhf_gate_reviewer"} {
		exec("UPDATE users SET password_hash=$2 WHERE id=$1", reviewer, string(passwordHash))
	}
	signer := func(id string) domain.User { return domain.User{ID: id, Login: id} }
	const intent = "I confirm this DHF review opinion and its fixed evidence identity"
	unauthorizedSign, unauthorizedSignErr := service.DHFPilotAttestReview(ctx, signer("dhf_gate_reviewer"),
		swTask, swOpinion.DecisionID, reviewerPassword, intent, "dhf-sign-someone-elses-review")
	if unauthorizedSignErr != nil || unauthorizedSign.Reason != "DHF_SCOPE_DENIED" {
		t.Fatalf("Gate task must not grant another reviewer's signoff: %+v %v", unauthorizedSign, unauthorizedSignErr)
	}
	wrongPassword, wrongPasswordErr := service.DHFPilotAttestReview(ctx, signer("dhf_sw_reviewer"),
		swTask, swOpinion.DecisionID, "wrong-password", intent, "dhf-attest-sw-wrong-password")
	if wrongPasswordErr != nil || wrongPassword.Reason != "DHF_REAUTH_FAILED" {
		t.Fatalf("incorrect password unexpectedly signed: %+v %v", wrongPassword, wrongPasswordErr)
	}
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE event_type='dhf.pilot.review_auth_denied' AND actor_id='dhf_sw_reviewer'").
		Scan(&count); err != nil || count != 1 {
		t.Fatalf("password denial must audit with no password material: %d %v", count, err)
	}
	prematureGateSign, prematureGateSignErr := service.DHFPilotAttestReview(ctx, signer("dhf_gate_reviewer"),
		gateTask, gateOpinion.DecisionID, reviewerPassword, intent, "dhf-gate-attest-before-specialties")
	if prematureGateSignErr == nil || prematureGateSign.Reason != "DHF_ATTESTATION_CONFLICT" {
		t.Fatalf("Gate reauthentication without predecessor attestations was accepted: %+v %v", prematureGateSign, prematureGateSignErr)
	}
	// The new signed identity row and the ordinary audit record must commit
	// together. A direct SQL attestation, however accurately it references
	// a legitimate reviewed decision, must never bypass audit provenance.
	var signPolicySHA, signManifestSHA string
	if err = pool.QueryRow(ctx, "SELECT policy_sha,manifest_sha FROM dhf_pilot_submissions WHERE id=$1",
		g5Result.SubmissionID).Scan(&signPolicySHA, &signManifestSHA); err != nil {
		t.Fatal(err)
	}
	if _, forgedErr := pool.Exec(ctx, `
INSERT INTO dhf_pilot_review_attestations(id,review_decision_id,task_id,submission_id,
 signer_id,outcome,sign_intent,policy_sha,manifest_sha,content_sha,idempotency_key,request_sha)
VALUES('dhf-no-auth-audit',$1,$2,$3,'dhf_sw_reviewer','recommend_pass',$4,
 $5,$6,repeat('f',64),'dhf-attestation-without-audit-0001',repeat('a',64))`,
		swOpinion.DecisionID, swTask, g5Result.SubmissionID, intent,
		signPolicySHA, signManifestSHA); forgedErr == nil {
		t.Fatal("direct signed review inserted without same-transaction audit")
	}
	mfSigned, mfSignedErr := service.DHFPilotAttestReview(ctx, signer("dhf_mf_reviewer"),
		mfTask, mfOpinion.DecisionID, reviewerPassword, intent, "dhf-attest-mf-0001")
	if mfSignedErr != nil || mfSigned.AttestationID == "" || mfSigned.Replayed {
		t.Fatalf("previously sponsored MF review could not reauthenticate: %+v %v", mfSigned, mfSignedErr)
	}
	var signInbox []ports.DHFPilotAttestationInboxRow
	signInbox, err = service.DHFPilotAttestationInbox(ctx, signer("dhf_gate_reviewer"))
	if err != nil || len(signInbox) != 1 || signInbox[0].CanAttest || signInbox[0].OutstandingPrior != 1 {
		t.Fatalf("Gate lost predecessor signature obligation: %+v %v", signInbox, err)
	}
	swSigned, swSignedErr := service.DHFPilotAttestReview(ctx, signer("dhf_sw_reviewer"),
		swTask, swOpinion.DecisionID, reviewerPassword, intent, "dhf-attest-sw-0001")
	if swSignedErr != nil || swSigned.AttestationID == "" {
		t.Fatalf("original SW reviewer unable to personally attest: %+v %v", swSigned, swSignedErr)
	}
	gateSigned, gateSignedErr := service.DHFPilotAttestReview(ctx, signer("dhf_gate_reviewer"),
		gateTask, gateOpinion.DecisionID, reviewerPassword, intent, "dhf-attest-gate-0001")
	if gateSignedErr != nil || gateSigned.AttestationID == "" || gateSigned.Replayed {
		t.Fatalf("Gate could not attest after ALL prior signed reviews: %+v %v", gateSigned, gateSignedErr)
	}
	// V0.7.4: a password-reauthenticated trial recommendation alone cannot
	// authorize a Gate. There must be a separately provisioned Ed25519 key.
	t.Setenv("DHF_PILOT_GATE_TRUSTED_PUBKEY_B64", "")
	untrusted, untrustedErr := service.DHFPilotGateChallenge(ctx, signer("dhf_gate_reviewer"), g5Result.SubmissionID)
	if untrustedErr != nil || untrusted.Reason != "DHF_GATE_TRUST_POLICY_MISSING" {
		t.Fatalf("unprovisioned Gate signing authority accepted: %+v %v", untrusted, untrustedErr)
	}
	publicKey, privateKey, keyErr := ed25519.GenerateKey(rand.Reader)
	if keyErr != nil {
		t.Fatal(keyErr)
	}
	t.Setenv("DHF_PILOT_GATE_TRUSTED_PUBKEY_B64", base64.StdEncoding.EncodeToString(publicKey))
	// A machine-wide trust anchor is insufficient: only an active,
	// user-bound, purpose-limited and independently audited credential may
	// sign the Gate candidate. An unregistered key remains denied.
	missingCredential, missingCredErr := service.DHFPilotGateChallenge(ctx, signer("dhf_gate_reviewer"), g5Result.SubmissionID)
	if missingCredErr != nil || missingCredential.Reason != "DHF_GATE_CREDENTIAL_INACTIVE" {
		t.Fatalf("public key without signer credential accepted: %+v %v", missingCredential, missingCredErr)
	}
	credentialTx, beginCredentialErr := pool.Begin(ctx)
	if beginCredentialErr != nil {
		t.Fatal(beginCredentialErr)
	}
	defer credentialTx.Rollback(ctx)
	if _, err = credentialTx.Exec(ctx, `
INSERT INTO dhf_pilot_signing_credentials(id,signer_id,public_key_ed25519,purpose,
 valid_from,expires_at,registered_by,authorization_ref)
VALUES('dhf-gate-credential','dhf_gate_reviewer',$1,'dhf.pilot.gate.candidate',
 now()-interval '1 day',now()+interval '1 day',$2,'isolated-pilot-test-authorization')`,
		publicKey, actorID); err != nil {
		t.Fatal(err)
	}
	if _, err = credentialTx.Exec(ctx, `
INSERT INTO audit_events(actor_id,event_type,target_kind,target_id,request_id,outcome,details)
VALUES($1,'dhf.pilot.credential.register','dhf_signing_credential',
 'dhf-gate-credential','dhf-gate-register-test-001','trial_only',
 jsonb_build_object('keySha',$2::text,'authorizationRef','isolated-pilot-test-authorization'))`,
		actorID, sha(publicKey)); err != nil {
		t.Fatal(err)
	}
	if _, err = credentialTx.Exec(ctx, `
INSERT INTO dhf_pilot_signing_credential_events(id,credential_id,actor_id,event_kind,reason)
VALUES('dhf-gate-credential-active','dhf-gate-credential',$1,'activate',
 'isolated trial fixture only')`, actorID); err != nil {
		t.Fatal(err)
	}
	if _, err = credentialTx.Exec(ctx, `
INSERT INTO audit_events(actor_id,event_type,target_kind,target_id,request_id,outcome,details)
VALUES($1,'dhf.pilot.credential.activate','dhf_signing_credential',
 'dhf-gate-credential','dhf-gate-activate-test-001','trial_only',jsonb_build_object('eventId','dhf-gate-credential-active'))`,
		actorID); err != nil {
		t.Fatal(err)
	}
	if err = credentialTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	challenge, challengeErr := service.DHFPilotGateChallenge(ctx, signer("dhf_gate_reviewer"), g5Result.SubmissionID)
	if challengeErr != nil || challenge.PayloadBase64 == "" || challenge.PayloadSHA == "" {
		t.Fatalf("assigned Gate challenge not generated: %+v %v", challenge, challengeErr)
	}
	message, decodeErr := base64.StdEncoding.DecodeString(challenge.PayloadBase64)
	if decodeErr != nil {
		t.Fatal(decodeErr)
	}
	validSignature := base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, message))
	forgedSignature := base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	badSignature, badSignatureErr := service.DHFPilotSealGateCandidate(ctx, signer("dhf_gate_reviewer"),
		g5Result.SubmissionID, reviewerPassword, forgedSignature, "dhf-gate-forged-signature-001")
	if badSignatureErr != nil || badSignature.Reason != "DHF_GATE_SIGNATURE_INVALID" {
		t.Fatalf("invalid Gate signature not denied: %+v %v", badSignature, badSignatureErr)
	}
	crossSigner, crossSignerErr := service.DHFPilotSealGateCandidate(ctx, signer("dhf_sw_reviewer"),
		g5Result.SubmissionID, reviewerPassword, validSignature, "dhf-gate-not-sponsor-001")
	if crossSignerErr != nil || crossSigner.Reason != "DHF_SCOPE_DENIED" {
		t.Fatalf("not-assigned Gate signer attempted to seal candidate: %+v %v", crossSigner, crossSignerErr)
	}
	withoutGatePreview, noGatePreviewErr := service.DHFPilotSealGateCandidate(ctx, signer("dhf_gate_reviewer"),
		g5Result.SubmissionID, reviewerPassword, validSignature, "dhf-gate-no-preview-001")
	if noGatePreviewErr != nil || withoutGatePreview.Reason != "DHF_GATE_EVIDENCE_DENIED" {
		t.Fatalf("Gate candidate bypassed current file ACL: %+v %v", withoutGatePreview, noGatePreviewErr)
	}
	exec("INSERT INTO acls(id,folder_id,subject_kind,subject_id,actions,granted_by) VALUES('dhf_g5_gate_preview','dhf_folder','user','dhf_gate_reviewer',ARRAY['list','preview']::text[],$1)", actorID)
	// Real source and valid reviewer credentials still cannot manufacture a
	// database Gate candidate without an audit row and exact queued outbox.
	if _, noAuditErr := pool.Exec(ctx, `
INSERT INTO dhf_pilot_gate_candidates(id,submission_id,attempt_id,project_id,stage_id,
 template_id,gate_attestation_id,signer_id,policy_sha,manifest_sha,decision_payload_sha,
 trusted_key_sha,trusted_public_key_ed25519,signature_ed25519,idempotency_key,request_sha)
 VALUES('dhf-forged-gate-no-audit',$1,'dhf_g5_attempt','dhf_project','G5','dhf_g5_tpl',
 $2,'dhf_gate_reviewer',$3,$4,$5,$6,$7,$8,'dhf-gate-no-audit-001',repeat('e',64))`,
		g5Result.SubmissionID, gateSigned.AttestationID, sha(g5Policy), sha(g5Manifest),
		challenge.PayloadSHA, sha(publicKey), publicKey, ed25519.Sign(privateKey, message)); noAuditErr == nil {
		t.Fatal("manual SQL inserted a Gate signature without atomic audit and outbox")
	}
	candidate, candidateErr := service.DHFPilotSealGateCandidate(ctx, signer("dhf_gate_reviewer"),
		g5Result.SubmissionID, reviewerPassword, validSignature, "dhf-gate-candidate-001")
	if candidateErr != nil || candidate.CandidateID == "" || candidate.Replayed || !candidate.TrialOnly {
		t.Fatalf("legitimate signed Gate trial candidate failed: %+v %v", candidate, candidateErr)
	}
	candidateRetry, candidateRetryErr := service.DHFPilotSealGateCandidate(ctx, signer("dhf_gate_reviewer"),
		g5Result.SubmissionID, reviewerPassword, validSignature, "dhf-gate-candidate-001")
	if candidateRetryErr != nil || !candidateRetry.Replayed || candidateRetry.CandidateID != candidate.CandidateID {
		t.Fatalf("same signed Gate candidate must replay original: %+v %v", candidateRetry, candidateRetryErr)
	}
	// Exact historical public verifier and signature remain available even
	// if the configured corporate pilot trust anchor later rotates.
	var persistedPub, persistedSignature []byte
	var persistedDigest string
	if err = pool.QueryRow(ctx, "SELECT trusted_public_key_ed25519,signature_ed25519,decision_payload_sha FROM dhf_pilot_gate_candidates WHERE id=$1", candidate.CandidateID).
		Scan(&persistedPub, &persistedSignature, &persistedDigest); err != nil ||
		!ed25519.Verify(persistedPub, message, persistedSignature) || persistedDigest != challenge.PayloadSHA {
		t.Fatalf("historical Gate signature no longer independently verifiable: %s %v", persistedDigest, err)
	}
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM outbox_jobs WHERE kind='dhf.pilot.gate.candidate' AND id=$1",
		"dhf-gate-candidate:"+candidate.CandidateID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("pilot Gate event not queued atomically: %d %v", count, err)
	}
	var credentialOnCandidate string
	if err = pool.QueryRow(ctx, "SELECT signing_credential_id FROM dhf_pilot_gate_candidates WHERE id=$1",
		candidate.CandidateID).Scan(&credentialOnCandidate); err != nil || credentialOnCandidate != "dhf-gate-credential" {
		t.Fatalf("Gate signature not bound to original identity credential: %q %v", credentialOnCandidate, err)
	}
	// Revocation is terminal and append-only. Earlier signatures remain
	// independently verifiable, while future challenges must fail closed.
	if _, unAuditedRevoke := pool.Exec(ctx, `
INSERT INTO dhf_pilot_signing_credential_events(id,credential_id,actor_id,event_kind,reason)
VALUES('dhf-gate-revoke-unaudited','dhf-gate-credential',$1,'revoke',
 'forged event without audit')`, actorID); unAuditedRevoke == nil {
		t.Fatal("credential lifecycle event without atomic audit committed")
	}
	revokeTx, revokeBeginErr := pool.Begin(ctx)
	if revokeBeginErr != nil {
		t.Fatal(revokeBeginErr)
	}
	defer revokeTx.Rollback(ctx)
	if _, err = revokeTx.Exec(ctx, `
INSERT INTO dhf_pilot_signing_credential_events(id,credential_id,actor_id,event_kind,reason)
VALUES('dhf-gate-credential-revoked','dhf-gate-credential',$1,'revoke',
 'isolated test key revocation')`, actorID); err != nil {
		t.Fatal(err)
	}
	if _, err = revokeTx.Exec(ctx, `
INSERT INTO audit_events(actor_id,event_type,target_kind,target_id,request_id,outcome,details)
VALUES($1,'dhf.pilot.credential.revoke','dhf_signing_credential',
 'dhf-gate-credential','dhf-gate-revoke-test-001','trial_only',jsonb_build_object('eventId','dhf-gate-credential-revoked'))`,
		actorID); err != nil {
		t.Fatal(err)
	}
	if err = revokeTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	revoked, revokedErr := service.DHFPilotGateChallenge(ctx, signer("dhf_gate_reviewer"), g5Result.SubmissionID)
	if revokedErr != nil || revoked.Reason != "DHF_GATE_CREDENTIAL_INACTIVE" {
		t.Fatalf("revoked credential still generated signable challenge: %+v %v", revoked, revokedErr)
	}
	if !ed25519.Verify(persistedPub, message, persistedSignature) {
		t.Fatal("historical Gate signature lost verification after revocation")
	}
	if _, reopenedErr := pool.Exec(ctx, `
INSERT INTO dhf_pilot_signing_credential_events(id,credential_id,actor_id,event_kind,reason)
VALUES('dhf-gate-credential-resumed','dhf-gate-credential',$1,'activate',
 'forbidden reactivation after revocation')`, actorID); reopenedErr == nil {
		t.Fatal("terminal revoked signing credential reactivated")
	}
	if _, tamper := pool.Exec(ctx, "UPDATE dhf_pilot_gate_candidates SET signature_ed25519=decode(repeat('a',128),'hex') WHERE id=$1",
		candidate.CandidateID); tamper == nil {
		t.Fatal("sealed Gate signature unexpectedly rewritten")
	}
	// Finish the temporary G5 signer ACL fixture before exercising G6
	// revocation tests; otherwise unrelated grants mask the denial.
	exec("DELETE FROM acls WHERE id='dhf_g5_gate_preview'")
	if err = pool.QueryRow(ctx, "SELECT state FROM dhf_pilot_attempts WHERE id='dhf_g5_attempt'").Scan(&state); err != nil || state != "submitted" {
		t.Fatalf("signed candidate was incorrectly promoted to official accepted stage: %s %v", state, err)
	}
	signedRetry, signedRetryErr := service.DHFPilotAttestReview(ctx, signer("dhf_gate_reviewer"),
		gateTask, gateOpinion.DecisionID, reviewerPassword, intent, "dhf-attest-gate-0001")
	if signedRetryErr != nil || !signedRetry.Replayed || signedRetry.AttestationID != gateSigned.AttestationID {
		t.Fatalf("exact reauthentication retry must reuse first signed event: %+v %v", signedRetry, signedRetryErr)
	}
	if _, tamper := pool.Exec(ctx, "UPDATE dhf_pilot_review_attestations SET signer_id='dhf_gate_reviewer' WHERE id=$1", swSigned.AttestationID); tamper == nil {
		t.Fatal("signer identity could be rewritten after account reauthentication")
	}
	if _, tamper := pool.Exec(ctx, "DELETE FROM dhf_pilot_review_attestations WHERE id=$1", mfSigned.AttestationID); tamper == nil {
		t.Fatal("re-authenticated review could be erased")
	}
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE event_type='dhf.pilot.review_attested' AND target_kind='dhf_review_task' AND target_id=$1", gateTask).Scan(&count); err != nil || count != 1 {
		t.Fatalf("signed Gate must have exactly one audit record: %d %v", count, err)
	}
	// An authenticated session alone is not an unlimited password oracle.
	// Failed reauthentication is counted per original account for 15 min.
	for attempt := 0; attempt < 5; attempt++ {
		denied, deniedErr := service.DHFPilotAttestReview(ctx, signer("dhf_mf_reviewer"),
			mfTask, mfOpinion.DecisionID, "invalid-DHF-password", intent,
			fmt.Sprintf("dhf-sign-attempt-denied-%d", attempt))
		if deniedErr != nil || denied.Reason != "DHF_REAUTH_FAILED" {
			t.Fatalf("wrong password attempt %d not denied and audited: %+v %v", attempt, denied, deniedErr)
		}
	}
	limited, limitedErr := service.DHFPilotAttestReview(ctx, signer("dhf_mf_reviewer"),
		mfTask, mfOpinion.DecisionID, reviewerPassword, intent, "dhf-signer-rate-limit-0001")
	if limitedErr != nil || limited.Reason != "DHF_REAUTH_RATE_LIMITED" {
		t.Fatalf("signer login password oracle not throttled: %+v %v", limited, limitedErr)
	}
	if err = pool.QueryRow(ctx, "SELECT state FROM dhf_pilot_attempts WHERE id='dhf_g5_attempt'").Scan(&state); err != nil || state != "submitted" {
		t.Fatalf("authenticated trial signatures must never silently grant formal stage acceptance: %s %v", state, err)
	}
	// Replay after BOTH the target and final Gate have finished must still
	// return the same immutable intervention; no new bypass is created.
	lateReplay, lateReplayErr := service.DHFPilotAuthorizeEarlyReview(ctx, domain.User{ID: "dhf_gate_reviewer"},
		mfTask, "为了并行评估工艺文件，允许生产审核人先提交意见；软件责任仍须单独完成", "dhf-gate-intervene-mf-0001")
	if lateReplayErr != nil || !lateReplay.Replayed || lateReplay.InterventionID != earlyMF.InterventionID {
		t.Fatalf("post-completion identical authorization replay failed: %+v %v", lateReplay, lateReplayErr)
	}

	if err = pool.QueryRow(ctx, "SELECT state FROM dhf_pilot_attempts WHERE id='dhf_g5_attempt'").Scan(&state); err != nil || state != "submitted" {
		t.Fatalf("trial recommendations must NOT formally approve stage: %q %v", state, err)
	}
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM dhf_pilot_review_decisions WHERE submission_id=$1", g5Result.SubmissionID).Scan(&count); err != nil || count != 3 {
		t.Fatalf("expected three immutable opinions: %d %v", count, err)
	}
	if _, mutateErr := pool.Exec(ctx, "UPDATE dhf_pilot_review_decisions SET comment='rewritten' WHERE id=$1", swOpinion.DecisionID); mutateErr == nil {
		t.Fatal("review opinion must be append-only")
	}
	// Returning a review requires a comment even for an authorized actor.
	seedG5("dhf_g5_unassigned")
	if _, deleteErr := pool.Exec(ctx, "DELETE FROM dhf_pilot_review_assignments WHERE project_id='dhf_project' AND stage_id='G5' AND review_key='G5-MF'"); deleteErr == nil {
		t.Fatal("applied review assignment must not be erased")
	}
	if _, updateErr := pool.Exec(ctx, "UPDATE dhf_pilot_review_assignments SET configured_by='dhf_sw_reviewer' WHERE project_id='dhf_project' AND stage_id='G5' AND review_key='G5-SW'"); updateErr == nil {
		t.Fatal("applied reviewer configuration history must not be modified")
	}
	if _, forgeErr := pool.Exec(ctx,
		"INSERT INTO dhf_pilot_workbench_tasks(id,submission_id,project_id,stage_id,review_key,reviewer_id,assigned_by) VALUES('dhf-forged-task',$1,'dhf_project','G5','G5-SW','dhf_sw_reviewer','dhf_gate_reviewer')", g5Result.SubmissionID); forgeErr == nil {
		t.Fatal("task with forged assigning actor should be rejected")
	}
	// G6 first design transfer is a DISTINCT Gate. Unconfigured reviewers
	// must abort the entire submission, and filling the assignment allows a
	// fresh transaction with the SAME idempotency key.
	g6Policy, err := json.Marshal(map[string]any{
		"stage_id": "G6", "conditional_allowed": false,
		"requirements": []dhf.RequirementPolicy{{ID: "DHF-REQ-001", Mandatory: true, Critical: true}},
		"dependencies": []dhf.DependencyPolicy{},
		"specialties":  []dhf.SpecialtyPolicy{},
	})
	if err != nil {
		t.Fatal(err)
	}
	exec("INSERT INTO dhf_pilot_templates(id,stage_id,policy_body,policy_sha,status,approved_by,approved_at) VALUES('dhf_g6_tpl','G6',$1,$2,'published',$3,now())", g6Policy, sha(g6Policy), actorID)
	exec("INSERT INTO dhf_pilot_baselines(project_id,stage_id,template_id,active) VALUES('dhf_project','G6','dhf_g6_tpl',true)")
	exec("INSERT INTO dhf_pilot_attempts(id,project_id,stage_id,template_id,manifest_body,manifest_sha,created_by) VALUES('dhf_g6_attempt','dhf_project','G6','dhf_g6_tpl',$1,$2,$3)", manifestBytes, sha(manifestBytes), actorID)
	missingReviewer, missingReviewerErr := service.DHFPilotSubmit(ctx, actor, "dhf_g6_attempt", "dhf-g6-transfer-0001")
	if missingReviewerErr == nil || missingReviewer.Verdict != dhf.Deny {
		t.Fatalf("G6 submission without review assignment must fail: %+v %v", missingReviewer, missingReviewerErr)
	}
	if err = pool.QueryRow(ctx, "SELECT state FROM dhf_pilot_attempts WHERE id='dhf_g6_attempt'").Scan(&state); err != nil || state != "preparing" {
		t.Fatalf("G6 failed reviewer validation failed to roll back: %q %v", state, err)
	}
	exec("INSERT INTO dhf_pilot_review_assignments(project_id,stage_id,review_key,reviewer_id,configured_by) VALUES('dhf_project','G6','__gate__','dhf_gate_reviewer',$1)", actorID)
	g6Result, g6Err := service.DHFPilotSubmit(ctx, actor, "dhf_g6_attempt", "dhf-g6-transfer-0001")
	if g6Err != nil || g6Result.Verdict != dhf.Allow {
		t.Fatalf("configured G6 gate submit: %+v %v", g6Result, g6Err)
	}
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM dhf_pilot_workbench_tasks WHERE submission_id=$1 AND stage_id='G6' AND review_key='__gate__' AND reviewer_id='dhf_gate_reviewer'", g6Result.SubmissionID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("G6 Gate task was not created atomically: %d %v", count, err)
	}
	// G6 is independent from G5. Return advice is not allowed without a
	// concrete explanation; any subsequent retry is a replay of the same
	// immutable result, not a second approval or an acceptance transition.
	var g6TaskID string
	if err = pool.QueryRow(ctx, "SELECT id FROM dhf_pilot_workbench_tasks WHERE submission_id=$1 AND review_key='__gate__'", g6Result.SubmissionID).Scan(&g6TaskID); err != nil {
		t.Fatal(err)
	}
	invalidReturn, invalidErr := service.DHFPilotRecommend(ctx, domain.User{ID: "dhf_gate_reviewer"}, g6TaskID,
		"recommend_return", " ", "dhf-g6-return-empty-0001")
	if invalidErr != nil || invalidReturn.Reason != "DHF_REVIEW_COMMENT_INVALID" {
		t.Fatalf("empty G6 return advice must fail: %+v %v", invalidReturn, invalidErr)
	}
	g6Review, g6ReviewErr := service.DHFPilotRecommend(ctx, domain.User{ID: "dhf_gate_reviewer"}, g6TaskID,
		"recommend_return", "首次转移证据未齐全", "dhf-g6-return-0001")
	if g6ReviewErr != nil || g6Review.Status != "returned" || g6Review.DecisionID == "" {
		t.Fatalf("G6 return opinion missing: %+v %v", g6Review, g6ReviewErr)
	}
	returnedInbox, returnedInboxErr := service.DHFPilotReturnInbox(ctx, actor)
	if returnedInboxErr != nil || len(returnedInbox) != 1 ||
		returnedInbox[0].DecisionID != g6Review.DecisionID ||
		returnedInbox[0].OriginalManifestSHA != sha(manifestBytes) ||
		!returnedInbox[0].CanPrepare {
		t.Fatalf("original author return inbox identity incorrect: %+v %v", returnedInbox, returnedInboxErr)
	}
	emptyReviewerInbox, emptyReviewerInboxErr := service.DHFPilotReturnInbox(ctx, domain.User{ID: "dhf_gate_reviewer"})
	if emptyReviewerInboxErr != nil || len(emptyReviewerInbox) != 0 {
		t.Fatalf("reviewer read other submitter's correction inbox: %+v %v", emptyReviewerInbox, emptyReviewerInboxErr)
	}
	g6Retry, g6RetryErr := service.DHFPilotRecommend(ctx, domain.User{ID: "dhf_gate_reviewer"}, g6TaskID,
		"recommend_return", "首次转移证据未齐全", "dhf-g6-return-0001")
	if g6RetryErr != nil || !g6Retry.Replayed || g6Retry.DecisionID != g6Review.DecisionID {
		t.Fatalf("G6 identical opinion retry must replay: %+v %v", g6Retry, g6RetryErr)
	}
	conflicting, conflictingErr := service.DHFPilotRecommend(ctx, domain.User{ID: "dhf_gate_reviewer"}, g6TaskID,
		"recommend_pass", "override previous return", "dhf-g6-return-newkey-0002")
	if conflictingErr != nil || conflicting.Reason != "DHF_REVIEW_ALREADY_DECIDED" {
		t.Fatalf("G6 cannot overwrite immutable advice: %+v %v", conflicting, conflictingErr)
	}
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM dhf_pilot_review_decisions WHERE task_id=$1", g6TaskID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("G6 recommendations must not duplicate: %d %v", count, err)
	}
	if _, tamperErr := pool.Exec(ctx, "UPDATE dhf_pilot_workbench_tasks SET status='pending' WHERE id=$1", g6TaskID); tamperErr == nil {
		t.Fatal("G6 task status must not regress without a new accountable review")
	}
	if err = pool.QueryRow(ctx, "SELECT state FROM dhf_pilot_attempts WHERE id='dhf_g6_attempt'").Scan(&state); err != nil || state != "submitted" {
		t.Fatalf("G6 trial recommendation must not close Gate: %q %v", state, err)
	}
	// V0.7.0: Returned G6 review creates a distinct new preparation attempt;
	// the first submission, decision and original frozen evidence are NEVER
	// overwritten. Neither reviewer nor global admin may forge ownership.
	revisedManifest, err := json.Marshal(map[string]any{"requirements": []map[string]any{{
		"id": "DHF-REQ-001", "applicability": "applicable", "file_id": "dhf_file",
		"version_seq": 2, "sha256": nextSHA,
	}}})
	if err != nil {
		t.Fatal(err)
	}
	plan := "按首次转移退回意见更正样机证据并由原责任人重新提交"
	illegal, illegalErr := service.DHFPilotOpenRemediation(ctx, domain.User{ID: "dhf_gate_reviewer"},
		g6Review.DecisionID, revisedManifest, plan, "dhf-remed-reviewer-illegal")
	if illegalErr != nil || illegal.Reason != "DHF_SCOPE_DENIED" {
		t.Fatalf("assigned reviewer may not initiate original submitter's remediation: %+v %v", illegal, illegalErr)
	}
	noChange, noChangeErr := service.DHFPilotOpenRemediation(ctx, actor,
		g6Review.DecisionID, manifestBytes, plan, "dhf-remed-no-evidence")
	if noChangeErr != nil || noChange.Reason != "DHF_REMEDIATION_EVIDENCE_UNCHANGED" {
		t.Fatalf("same manifest cannot count as remediation: %+v %v", noChange, noChangeErr)
	}
	// An immutable remediation must NOT consume the unique return decision
	// when its proposed file tuple is not a real authorized file version.
	forgedManifest, err := json.Marshal(map[string]any{"requirements": []map[string]any{{
		"id": "DHF-REQ-001", "applicability": "applicable", "file_id": "dhf_file",
		"version_seq": 999, "sha256": strings.Repeat("f", 64),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	forgedCase, forgedErr := service.DHFPilotOpenRemediation(ctx, actor,
		g6Review.DecisionID, forgedManifest, plan, "dhf-remed-forged-version")
	if forgedErr != nil || forgedCase.Reason != "DHF_REMEDIATION_PREPARE_DENIED" {
		t.Fatalf("invalid physical/version identity must not consume remediation: %+v %v", forgedCase, forgedErr)
	}
	if err = pool.QueryRow(ctx,
		"SELECT count(*) FROM dhf_pilot_remediation_cases WHERE return_decision_id=$1",
		g6Review.DecisionID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("invalid remediation was not transactionally rolled back: %d %v", count, err)
	}
	notReturned, notReturnedErr := service.DHFPilotOpenRemediation(ctx, actor,
		swOpinion.DecisionID, revisedManifest, plan, "dhf-remed-unreturned-review")
	if notReturnedErr != nil || notReturned.Reason != "DHF_SCOPE_DENIED" {
		t.Fatalf("pass recommendation cannot be treated as a returned review: %+v %v", notReturned, notReturnedErr)
	}
	remed, remedErr := service.DHFPilotOpenRemediation(ctx, actor, g6Review.DecisionID,
		revisedManifest, plan, "dhf-remed-g6-0001")
	if remedErr != nil || remed.CaseID == "" || remed.NewAttemptID == "" || remed.Replayed {
		t.Fatalf("cannot create an immutable return→new attempt lineage: %+v %v", remed, remedErr)
	}
	caseInbox, caseInboxErr := service.DHFPilotReturnInbox(ctx, actor)
	if caseInboxErr != nil || len(caseInbox) != 1 ||
		caseInbox[0].CaseID != remed.CaseID ||
		caseInbox[0].NewAttemptID != remed.NewAttemptID ||
		caseInbox[0].NewAttemptState != "preparing" {
		t.Fatalf("return inbox did not link fresh independent attempt: %+v %v", caseInbox, caseInboxErr)
	}
	remedReplay, remedReplayErr := service.DHFPilotOpenRemediation(ctx, actor, g6Review.DecisionID,
		revisedManifest, plan, "dhf-remed-g6-0001")
	if remedReplayErr != nil || !remedReplay.Replayed || remedReplay.CaseID != remed.CaseID ||
		remedReplay.NewAttemptID != remed.NewAttemptID {
		t.Fatalf("identical remediation must replay original attempt: %+v %v", remedReplay, remedReplayErr)
	}
	remedConflict, remedConflictErr := service.DHFPilotOpenRemediation(ctx, actor, g6Review.DecisionID,
		revisedManifest, plan+"不同范围", "dhf-remed-g6-0002")
	if remedConflictErr != nil || remedConflict.Reason != "DHF_REMEDIATION_ALREADY_EXISTS" {
		t.Fatalf("conflicting remediation cannot rewrite accepted plan: %+v %v", remedConflict, remedConflictErr)
	}
	for _, query := range []string{
		"SELECT count(*) FROM dhf_pilot_remediation_cases WHERE id=$1 AND return_decision_id=$2",
		"SELECT count(*) FROM dhf_pilot_remediation_events WHERE case_id=$1 AND kind='opened'",
		"SELECT count(*) FROM audit_events WHERE event_type='dhf.pilot.remediation.opened' AND target_id=$1",
	} {
		var probeErr error
		if strings.Contains(query, "$2") {
			probeErr = pool.QueryRow(ctx, query, remed.CaseID, g6Review.DecisionID).Scan(&count)
		} else {
			probeErr = pool.QueryRow(ctx, query, remed.CaseID).Scan(&count)
		}
		if probeErr != nil || count != 1 {
			t.Fatalf("remediation journal count invalid: %s: %d %v", query, count, probeErr)
		}
	}
	if err = pool.QueryRow(ctx, "SELECT state FROM dhf_pilot_attempts WHERE id=$1", remed.NewAttemptID).Scan(&state); err != nil || state != "preparing" {
		t.Fatalf("new attempt must start preparing: %s %v", state, err)
	}
	if _, rewriteErr := pool.Exec(ctx, "UPDATE dhf_pilot_attempts SET manifest_sha=repeat('f',64) WHERE id=$1", remed.NewAttemptID); rewriteErr == nil {
		t.Fatal("immutable remediation-linked preparing manifest identity was rewritten")
	}
	if err = pool.QueryRow(ctx, "SELECT state FROM dhf_pilot_attempts WHERE id='dhf_g6_attempt'").Scan(&state); err != nil || state != "submitted" {
		t.Fatalf("original returned attempt state was overwritten: %s %v", state, err)
	}
	if _, err = pool.Exec(ctx, "UPDATE dhf_pilot_remediation_cases SET resolution_plan='post-hoc tampering' WHERE id=$1", remed.CaseID); err == nil {
		t.Fatal("DHF immutable remediation case unexpectedly rewritten")
	}
	if _, err = pool.Exec(ctx, "DELETE FROM dhf_pilot_remediation_events WHERE case_id=$1", remed.CaseID); err == nil {
		t.Fatal("DHF immutable remediation event unexpectedly deleted")
	}
	remedSubmit, remedSubmitErr := service.DHFPilotSubmit(ctx, actor, remed.NewAttemptID,
		"dhf-revised-g6-submit-0001")
	if remedSubmitErr != nil || remedSubmit.Verdict != dhf.Allow || remedSubmit.SubmissionID == "" {
		t.Fatalf("corrected G6 new attempt could not submit through existing Gate: %+v %v", remedSubmit, remedSubmitErr)
	}
	if err = pool.QueryRow(ctx,
		"SELECT count(*) FROM dhf_pilot_workbench_tasks WHERE submission_id=$1 AND stage_id='G6' AND review_key='__gate__'",
		remedSubmit.SubmissionID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("corrected attempt must create a NEW independent G6 reviewer task: %d %v", count, err)
	}
	// V0.7.3: returned advice and a corrected submission are insufficient.
	// The original reviewer first authenticates the RETURN, then every new
	// reviewer must password-attest their independent corrected decision.
	const verifiedPlan = "我已逐项复核原退回问题及新冻结版本，确认整改证据充分且责任完整"
	const verifyIntent = "I personally verified the corrected DHF submission against my original return"
	earlyVerify, earlyVerifyErr := service.DHFPilotVerifyRemediation(ctx, signer("dhf_gate_reviewer"),
		remed.CaseID, verifiedPlan, reviewerPassword, verifyIntent, "dhf-verify-before-return-sign")
	if earlyVerifyErr != nil || earlyVerify.Reason != "DHF_SCOPE_DENIED" {
		t.Fatalf("unsigned original return cannot permit closure: %+v %v", earlyVerify, earlyVerifyErr)
	}
	originalReturnSigned, originalReturnErr := service.DHFPilotAttestReview(ctx, signer("dhf_gate_reviewer"),
		g6TaskID, g6Review.DecisionID, reviewerPassword, intent, "dhf-g6-original-return-attest")
	if originalReturnErr != nil || originalReturnSigned.AttestationID == "" {
		t.Fatalf("original return not signed by actual reviewer: %+v %v", originalReturnSigned, originalReturnErr)
	}
	exec("INSERT INTO acls(id,folder_id,subject_kind,subject_id,actions,granted_by) VALUES('dhf_gate_file_preview','dhf_folder','user','dhf_gate_reviewer',ARRAY['list','preview']::text[],$1)", actorID)
	unsignedFix, unsignedFixErr := service.DHFPilotVerifyRemediation(ctx, signer("dhf_gate_reviewer"),
		remed.CaseID, verifiedPlan, reviewerPassword, verifyIntent, "dhf-verify-before-corrected-review")
	if unsignedFixErr == nil || unsignedFix.Reason != "DHF_VERIFICATION_PRECONDITION" {
		t.Fatalf("unreviewed corrected submission unexpectedly closed: %+v %v", unsignedFix, unsignedFixErr)
	}
	wrongReviewer, wrongReviewerErr := service.DHFPilotVerifyRemediation(ctx, actor,
		remed.CaseID, verifiedPlan, reviewerPassword, verifyIntent, "dhf-verify-by-submitter")
	if wrongReviewerErr != nil || wrongReviewer.Reason != "DHF_SCOPE_DENIED" {
		t.Fatalf("source submitter forged review verification: %+v %v", wrongReviewer, wrongReviewerErr)
	}
	var revisedG6Task string
	if err = pool.QueryRow(ctx,
		"SELECT id FROM dhf_pilot_workbench_tasks WHERE submission_id=$1 AND review_key='__gate__'",
		remedSubmit.SubmissionID).Scan(&revisedG6Task); err != nil {
		t.Fatal(err)
	}
	revisedOpinion, revisedOpinionErr := service.DHFPilotRecommend(ctx, signer("dhf_gate_reviewer"),
		revisedG6Task, "recommend_pass", "更正样机证据已复核", "dhf-revised-g6-gate-pass")
	if revisedOpinionErr != nil || revisedOpinion.Status != "reviewed" {
		t.Fatalf("corrected attempt independent Gate review failed: %+v %v", revisedOpinion, revisedOpinionErr)
	}
	onlyRecommendation, onlyRecommendationErr := service.DHFPilotVerifyRemediation(ctx, signer("dhf_gate_reviewer"),
		remed.CaseID, verifiedPlan, reviewerPassword, verifyIntent, "dhf-verify-not-signed-corrected")
	if onlyRecommendationErr == nil || onlyRecommendation.Reason != "DHF_VERIFICATION_PRECONDITION" {
		t.Fatalf("unsigned corrected Gate suggestion wrongly closed remediation: %+v %v", onlyRecommendation, onlyRecommendationErr)
	}
	revisedSigned, revisedSignedErr := service.DHFPilotAttestReview(ctx, signer("dhf_gate_reviewer"),
		revisedG6Task, revisedOpinion.DecisionID, reviewerPassword, intent, "dhf-revised-g6-auth-review")
	if revisedSignedErr != nil || revisedSigned.AttestationID == "" {
		t.Fatalf("corrected review not reauthenticated: %+v %v", revisedSigned, revisedSignedErr)
	}
	verificationCases, verificationInboxErr := service.DHFPilotVerificationInbox(ctx, signer("dhf_gate_reviewer"))
	if verificationInboxErr != nil || len(verificationCases) != 1 ||
		verificationCases[0].CaseID != remed.CaseID ||
		!verificationCases[0].ReadyToVerify ||
		verificationCases[0].RevisedSubmissionID != remedSubmit.SubmissionID {
		t.Fatalf("original reviewer cannot see ready correction: %+v %v", verificationCases, verificationInboxErr)
	}
	notReviewerInbox, notReviewerInboxErr := service.DHFPilotVerificationInbox(ctx, actor)
	if notReviewerInboxErr != nil || len(notReviewerInbox) != 0 {
		t.Fatalf("original submitter improperly saw reviewer verification queue: %+v %v", notReviewerInbox, notReviewerInboxErr)
	}
	// A direct SQL insertion cannot create a purported correction verification
	// without a matching audit event committed in the same transaction.
	if _, forgedErr := pool.Exec(ctx, `
INSERT INTO dhf_pilot_remediation_verifications(id,case_id,original_return_attestation_id,
 revised_submission_id,verifier_id,comment,original_manifest_sha,revised_manifest_sha,
 revised_policy_sha,idempotency_key,request_sha)
VALUES('dhf-unlogged-verification',$1,$2,$3,'dhf_gate_reviewer',$4,$5,$6,$7,
 'dhf-rework-unlogged-0001',repeat('a',64))`,
		remed.CaseID, originalReturnSigned.AttestationID, remedSubmit.SubmissionID,
		verifiedPlan, sha(manifestBytes), sha(revisedManifest), sha(g6Policy)); forgedErr == nil {
		t.Fatal("direct unaudited correction verification was accepted")
	}
	wrongVerifyPassword, wrongVerifyErr := service.DHFPilotVerifyRemediation(ctx, signer("dhf_gate_reviewer"),
		remed.CaseID, verifiedPlan, "DHF-invalid-password", verifyIntent, "dhf-verify-wrong-password")
	if wrongVerifyErr != nil || wrongVerifyPassword.Reason != "DHF_REAUTH_FAILED" {
		t.Fatalf("passwordless correction verification accepted: %+v %v", wrongVerifyPassword, wrongVerifyErr)
	}
	exec("DELETE FROM acls WHERE id='dhf_gate_file_preview'")
	withoutReadAccess, withoutReadErr := service.DHFPilotVerifyRemediation(ctx, signer("dhf_gate_reviewer"),
		remed.CaseID, verifiedPlan, reviewerPassword, verifyIntent, "dhf-verify-no-preview-access")
	if withoutReadErr != nil || withoutReadAccess.Reason != "DHF_VERIFICATION_EVIDENCE_DENIED" {
		t.Fatalf("reviewer cannot verify remediation without original file preview grant: %+v %v", withoutReadAccess, withoutReadErr)
	}
	exec("INSERT INTO acls(id,folder_id,subject_kind,subject_id,actions,granted_by) VALUES('dhf_gate_file_preview','dhf_folder','user','dhf_gate_reviewer',ARRAY['list','preview']::text[],$1)", actorID)
	tamperSourcePath, sourcePathErr := physicalStore.PathFor(storageKey)
	if sourcePathErr != nil {
		t.Fatal(sourcePathErr)
	}
	if err = os.WriteFile(tamperSourcePath, []byte("DHF fixture physically altered prior to verified closure"), 0600); err != nil {
		t.Fatal(err)
	}
	corruptedBlob, corruptedBlobErr := service.DHFPilotVerifyRemediation(ctx, signer("dhf_gate_reviewer"),
		remed.CaseID, verifiedPlan, reviewerPassword, verifyIntent, "dhf-verify-corrupted-blob")
	if corruptedBlobErr != nil || corruptedBlob.Reason != "DHF_VERIFICATION_EVIDENCE_INVALID" {
		t.Fatalf("physically corrupted frozen original file allowed correction closure: %+v %v", corruptedBlob, corruptedBlobErr)
	}
	if err = os.WriteFile(tamperSourcePath, content, 0600); err != nil {
		t.Fatal(err)
	}
	verified, verifiedErr := service.DHFPilotVerifyRemediation(ctx, signer("dhf_gate_reviewer"),
		remed.CaseID, verifiedPlan, reviewerPassword, verifyIntent, "dhf-verification-001")
	if verifiedErr != nil || verified.VerificationID == "" || verified.Replayed {
		t.Fatalf("fully signed corrected case not independently verified: %+v %v", verified, verifiedErr)
	}
	verifiedAgain, verifiedAgainErr := service.DHFPilotVerifyRemediation(ctx, signer("dhf_gate_reviewer"),
		remed.CaseID, verifiedPlan, reviewerPassword, verifyIntent, "dhf-verification-001")
	if verifiedAgainErr != nil || !verifiedAgain.Replayed || verifiedAgain.VerificationID != verified.VerificationID {
		t.Fatalf("identical remediation verification not idempotent: %+v %v", verifiedAgain, verifiedAgainErr)
	}
	changedRequest, changedRequestErr := service.DHFPilotVerifyRemediation(ctx, signer("dhf_gate_reviewer"),
		remed.CaseID, verifiedPlan+"不同结论", reviewerPassword, verifyIntent, "dhf-verification-002")
	if changedRequestErr != nil || changedRequest.Reason != "DHF_VERIFICATION_ALREADY_EXISTS" {
		t.Fatalf("verified case cannot be overwritten with a different claim: %+v %v", changedRequest, changedRequestErr)
	}
	authorAfterVerify, authorAfterErr := service.DHFPilotReturnInbox(ctx, actor)
	if authorAfterErr != nil || len(authorAfterVerify) != 1 || authorAfterVerify[0].VerificationID != verified.VerificationID {
		t.Fatalf("submitter must see independent source-reviewer verification: %+v %v", authorAfterVerify, authorAfterErr)
	}
	if _, err = pool.Exec(ctx, "DELETE FROM dhf_pilot_remediation_verifications WHERE id=$1", verified.VerificationID); err == nil {
		t.Fatal("corrective verification deleted after completion")
	}
	if _, err = pool.Exec(ctx, "UPDATE dhf_pilot_remediation_verifications SET comment='retroactive change' WHERE id=$1", verified.VerificationID); err == nil {
		t.Fatal("corrective verification rewritten")
	}
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE event_type='dhf.pilot.remediation.verified' AND target_id=$1", remed.CaseID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("correction verification missing audit or duplicated: %d %v", count, err)
	}
	if err = pool.QueryRow(ctx, "SELECT state FROM dhf_pilot_attempts WHERE id=$1", remed.NewAttemptID).Scan(&state); err != nil || state != "submitted" {
		t.Fatalf("correction verification illegally accepted stage: %s %v", state, err)
	}
	// Real physical tampering must be detected even if DB Blob rows and
	// immutable file_versions still report the original checksum.
	path, err := physicalStore.PathFor(storageKey)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte("XXX pilot immutable evidence bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	seedAttempt("dhf_attempt_tamper")
	tampered, submitErr := service.DHFPilotSubmit(ctx, actor, "dhf_attempt_tamper", "dhf-isolated-tamper-0001")
	if submitErr != nil || tampered.Verdict != dhf.Deny ||
		!slices.Contains(tampered.ReasonCodes, "DHF_EVIDENCE_BYTES_INVALID") {
		t.Fatalf("physically altered evidence was accepted: %+v %v", tampered, submitErr)
	}
	if _, err = service.DHFPilotReviewerEvidencePreview(ctx, domain.User{ID: "dhf_sw_reviewer"}, swTask, "REQ-G5-SW"); err == nil {
		t.Fatal("reviewer preview must recheck physical bytes after disk corruption")
	}
	if err = os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
	// Negative security scenario: losing the original file grant denies new
	// submissions even when project membership and a valid manifest remain.
	exec("DELETE FROM acls WHERE id='dhf_acl'")
	seedAttempt("dhf_attempt_2")
	denied, err := service.DHFPilotSubmit(ctx, domain.User{ID: actorID}, "dhf_attempt_2", "dhf-isolated-idempotency-0003")
	if err != nil || denied.Verdict != dhf.Deny {
		t.Fatalf("revoked ACL was not enforced: %+v %v", denied, err)
	}
	err = pool.QueryRow(ctx, "SELECT count(*) FROM dhf_pilot_submissions WHERE attempt_id='dhf_attempt_2'").Scan(&count)
	if err != nil || count != 0 {
		t.Fatalf("denied submit had DB side effects: %d %v", count, err)
	}
	// The new bidirectional invariant blocks a "submitted" state that has
	// no corresponding immutable journal entry.
	seedAttempt("dhf_attempt_3")
	if _, err := pool.Exec(ctx,
		"UPDATE dhf_pilot_attempts SET state='submitted' WHERE id='dhf_attempt_3'"); err == nil {
		t.Fatal("unsigned standalone submitted state was accepted")
	}
	if err = pool.QueryRow(ctx,
		"SELECT state FROM dhf_pilot_attempts WHERE id='dhf_attempt_3'").Scan(&state); err != nil || state != "preparing" {
		t.Fatalf("standalone submitted state was not rolled back: %q %v", state, err)
	}
	// A fabricated journal with correct attempt/role but the wrong policy
	// digest must roll back its attempt transition and journal atomically.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, "UPDATE dhf_pilot_attempts SET state='submitted' WHERE id='dhf_attempt_3'")
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, "INSERT INTO dhf_pilot_submissions(id,attempt_id,project_id,stage_id,template_id,submitted_by,idempotency_key,request_sha,policy_sha,manifest_sha) VALUES('forged-sub','dhf_attempt_3','dhf_project','G1','dhf_tpl',$1,'forged-policy-key-0001',$2,$3,$4)",
		actorID, strings.Repeat("b", 64), strings.Repeat("e", 64), sha(manifestBytes))
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err == nil {
		t.Fatal("wrong template digest accepted at commit")
	}
	if err = pool.QueryRow(ctx, "SELECT state FROM dhf_pilot_attempts WHERE id='dhf_attempt_3'").Scan(&state); err != nil || state != "preparing" {
		t.Fatalf("forged commit modified frozen state %q %v", state, err)
	}
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM dhf_pilot_submissions WHERE id='forged-sub'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("forged submission was persisted: %d %v", count, err)
	}
	// A DB reference must prohibit gc_pending and DELETE, even if an operator
	// attempts manual SQL after submission; unreferenced blobs are unaffected.
	if _, err := pool.Exec(ctx, "UPDATE blobs SET state='gc_pending' WHERE id='dhf_blob'"); err == nil {
		t.Fatal("DHF referenced blob entered gc_pending")
	}
	if _, err := pool.Exec(ctx, "DELETE FROM blobs WHERE id='dhf_blob'"); err == nil {
		t.Fatal("DHF referenced blob was deleted")
	}
	for _, statement := range []string{
		"UPDATE blobs SET storage_key='ready/ff/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' WHERE id='dhf_blob'",
		"UPDATE blobs SET sha256=repeat('f',64) WHERE id='dhf_blob'",
		"UPDATE blobs SET size_bytes=999 WHERE id='dhf_blob'",
	} {
		if _, err := pool.Exec(ctx, statement); err == nil {
			t.Fatalf("referenced Blob identity was mutated: %s", statement)
		}
	}
	if _, err := pool.Exec(ctx, "UPDATE dhf_pilot_attempts SET state='reviewing' WHERE id='dhf_attempt_1'"); err == nil {
		t.Fatal("pilot accepted unimplemented review state")
	}
	fmt.Println("DHF_V064_DB_INTEGRATION_PASS")
}

// Same interface adaptation as cmd/server: Stage exposes the ports contract,
// while Open remains the production BlobStore implementation.
type dhfTestBlobAdapter struct{ *blob.Store }

func (a dhfTestBlobAdapter) Stage() (ports.BlobStage, error) { return a.Store.Stage() }
