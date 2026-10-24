package postgres_test

import (
	"context"
	"crypto/sha256"
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
)

// Opt-in ONLY: run after applying ALL migrations to a fresh isolated database.
// Database-name check prevents accidentally writing into a business database.
func TestDHFPilotRealPostgresSubmission(t *testing.T) {
	dsn:=os.Getenv("DHF_TEST_DATABASE_URL")
	if dsn=="" {t.Skip("isolated DHF integration database not configured")}
	ctx:=context.Background()
	pool,err:=pgxpool.New(ctx,dsn)
	if err!=nil{t.Fatal(err)}
	defer pool.Close()
	var dbName string
	if err=pool.QueryRow(ctx,"SELECT current_database()").Scan(&dbName);err!=nil{t.Fatal(err)}
	if !strings.HasPrefix(dbName,"filesmanage_dhf_v063_integration_") {
		t.Fatalf("refusing DHF integration test against non-isolated database %q",dbName)
	}
	exec:=func(sql string,args ...any){
		t.Helper()
		if _,err:=pool.Exec(ctx,sql,args...);err!=nil{t.Fatalf("setup SQL: %v",err)}
	}
	sha:=func(b []byte)string{h:=sha256.Sum256(b);return hex.EncodeToString(h[:])}
	actorID:="dhf_v063_test_user"
	exec("INSERT INTO users(id,login,display_name,password_hash) VALUES($1,$1,'DHF Test','not-a-real-password')",actorID)
	exec("INSERT INTO folders(id,name,owner_id) VALUES('dhf_folder','DHF Test', $1)",actorID)
	exec("INSERT INTO acls(id,folder_id,subject_kind,subject_id,actions,granted_by) VALUES('dhf_acl','dhf_folder','user',$1,ARRAY['list','download']::text[],$1)",actorID)
	// Stage REAL content through the production BlobStore. Database metadata
	// alone must never be sufficient for an approved DHF evidence submission.
	physicalStore:=blob.New(t.TempDir())
	stage,err:=physicalStore.Stage()
	if err!=nil {t.Fatal(err)}
	content:=[]byte("DHF pilot immutable evidence bytes")
	if _,err=stage.Write(content);err!=nil {t.Fatal(err)}
	storageKey,_,err:=stage.Commit()
	if err!=nil {t.Fatal(err)}
	fileSHA:=stage.Sha256()
	exec("INSERT INTO blobs(id,storage_key,sha256,size_bytes,state) VALUES('dhf_blob',$1,$2,$3,'ready')",storageKey,fileSHA,len(content))
	exec("INSERT INTO files(id,folder_id,name,uploaded_by) VALUES('dhf_file','dhf_folder','artifact.txt',$1)",actorID)
	exec("INSERT INTO file_versions(id,file_id,seq,blob_id,sha256,size_bytes,action,created_by) VALUES('dhf_v1','dhf_file',1,'dhf_blob',$1,$2,'upload',$3)",fileSHA,len(content),actorID)
	// Match the real upload lifecycle: current pointer is set only after the
	// immutable version exists, otherwise fileSelect sees NULL version fields.
	exec("UPDATE files SET current_version_seq=1 WHERE id='dhf_file'")
	policyBytes,err:=json.Marshal(map[string]any{
		"stage_id":"G1","conditional_allowed":false,
		"requirements":[]dhf.RequirementPolicy{{ID:"DHF-REQ-001",Mandatory:true,Critical:true,ConditionEligible:false,AllowNotApplicable:false}},
		"dependencies":[]dhf.DependencyPolicy{},
		"specialties":[]dhf.SpecialtyPolicy{},
	})
	if err!=nil{t.Fatal(err)}
	manifestBytes,err:=json.Marshal(map[string]any{
		"requirements":[]map[string]any{{
			"id":"DHF-REQ-001","applicability":"applicable",
			"file_id":"dhf_file","version_seq":1,"sha256":fileSHA,
		}},
	})
	if err!=nil{t.Fatal(err)}
	exec("INSERT INTO dhf_pilot_templates(id,stage_id,policy_body,policy_sha,status,approved_by,approved_at) VALUES('dhf_tpl','G1',$1,$2,'published',$3,now())",policyBytes,sha(policyBytes),actorID)
	exec("INSERT INTO dhf_pilot_projects(id,owner_id,state) VALUES('dhf_project',$1,'active')",actorID)
	exec("INSERT INTO dhf_pilot_baselines(project_id,stage_id,template_id,active) VALUES('dhf_project','G1','dhf_tpl',true)")
	exec("INSERT INTO dhf_pilot_members(project_id,user_id,can_prepare,can_submit) VALUES('dhf_project',$1,true,true)",actorID)
	seedAttempt:=func(id string) {
		t.Helper()
		exec("INSERT INTO dhf_pilot_attempts(id,project_id,stage_id,template_id,manifest_body,manifest_sha,created_by) VALUES($1,'dhf_project','G1','dhf_tpl',$2,$3,$4)",id,manifestBytes,sha(manifestBytes),actorID)
	}
	seedAttempt("dhf_attempt_1")
	service:=application.New(postgres.New(pool),dhfTestBlobAdapter{Store:physicalStore})
	actor:=domain.User{ID:actorID,IsAdmin:true} // caller flag intentionally untrusted
	first,err:=service.DHFPilotSubmit(ctx,actor,"dhf_attempt_1","dhf-isolated-idempotency-0001")
	if err!=nil || first.Verdict!=dhf.Allow || first.Replayed || first.SubmissionID=="" {
		t.Fatalf("first DB submission denied: %+v error=%v",first,err)
	}
	retry,err:=service.DHFPilotSubmit(ctx,actor,"dhf_attempt_1","dhf-isolated-idempotency-0001")
	if err!=nil || !retry.Replayed || retry.SubmissionID!=first.SubmissionID {
		t.Fatalf("DB idempotent retry: %+v error=%v",retry,err)
	}
	different,err:=service.DHFPilotSubmit(ctx,actor,"dhf_attempt_1","dhf-isolated-idempotency-0002")
	if err!=nil || different.Verdict!=dhf.Deny {t.Fatalf("different key reused: %+v %v",different,err)}
	var state string
	var count int
	err=pool.QueryRow(ctx,"SELECT state FROM dhf_pilot_attempts WHERE id='dhf_attempt_1'").Scan(&state)
	if err!=nil || state!="submitted" {t.Fatalf("attempt state %q: %v",state,err)}
	for _,query:=range []string{
		"SELECT count(*) FROM dhf_pilot_submissions WHERE attempt_id='dhf_attempt_1'",
		"SELECT count(*) FROM dhf_pilot_submission_evidence WHERE submission_id=$1 AND file_id='dhf_file' AND version_seq=1 AND sha256=$2",
		"SELECT count(*) FROM audit_events WHERE event_type='dhf.pilot.submitted' AND target_id='dhf_attempt_1'",
	} {
		if strings.Contains(query,"$1") {
			err=pool.QueryRow(ctx,query,first.SubmissionID,fileSHA).Scan(&count)
		} else {
			err=pool.QueryRow(ctx,query).Scan(&count)
		}
		if err!=nil || count!=1 {t.Fatalf("expected one persisted journal/hold/audit: %s -> %d %v",query,count,err)}
	}
	// Competing SERIALIZABLE submissions for the SAME attempt must commit
	// exactly once. Other contenders may see a serialization conflict or a
	// replay, but can never create a second journal/evidence/audit record.
	seedAttempt("dhf_attempt_race")
	const contenders=6
	type raceResult struct { outcome application.DHFPilotSubmitOutcome; err error }
	barrier:=make(chan struct{})
	results:=make(chan raceResult,contenders)
	var wg sync.WaitGroup
	for i:=0;i<contenders;i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-barrier
			got,submitErr:=service.DHFPilotSubmit(ctx,actor,"dhf_attempt_race","dhf-isolated-concurrent-0001")
			results<-raceResult{outcome:got,err:submitErr}
		}()
	}
	close(barrier)
	wg.Wait()
	close(results)
	uniqueWriters:=0
	for result:=range results {
		if result.err==nil && result.outcome.Verdict==dhf.Allow && !result.outcome.Replayed {
			uniqueWriters++
		}
	}
	if uniqueWriters!=1 {t.Fatalf("concurrent writers=%d, require exactly one",uniqueWriters)}
	for _,query:=range []string{
		"SELECT count(*) FROM dhf_pilot_submissions WHERE attempt_id='dhf_attempt_race'",
		"SELECT count(*) FROM audit_events WHERE event_type='dhf.pilot.submitted' AND target_id='dhf_attempt_race'",
		"SELECT count(*) FROM dhf_pilot_submission_evidence e JOIN dhf_pilot_submissions s ON s.id=e.submission_id WHERE s.attempt_id='dhf_attempt_race'",
	} {
		if err=pool.QueryRow(ctx,query).Scan(&count);err!=nil || count!=1 {
			t.Fatalf("concurrent submit duplicate journal/audit/evidence %q: %d %v",query,count,err)
		}
	}
	eventual,err:=service.DHFPilotSubmit(ctx,actor,"dhf_attempt_race","dhf-isolated-concurrent-0001")
	if err!=nil || eventual.Verdict!=dhf.Allow || !eventual.Replayed {
		t.Fatalf("eventual exact replay must recover committed result: %+v %v",eventual,err)
	}
	// Submitted G5 evidence must create distinct professional + stage-Gate
	// review tasks in the EXISTING Workbench, assigned only by explicit
	// reviewer configuration, never inherited from global admin privileges.
	for _, reviewer:=range []string{"dhf_sw_reviewer","dhf_mf_reviewer","dhf_gate_reviewer"} {
		exec("INSERT INTO users(id,login,display_name,password_hash) VALUES($1,$1,$1,'not-a-real-password')",reviewer)
		exec("INSERT INTO dhf_pilot_members(project_id,user_id) VALUES('dhf_project',$1)",reviewer)
	}
	g5Policy,err:=json.Marshal(map[string]any{
		"stage_id":"G5","conditional_allowed":false,
		"requirements":[]dhf.RequirementPolicy{
			{ID:"REQ-G5-SW",SpecialtyKey:"G5-SW",Mandatory:true,Critical:true},
			{ID:"REQ-G5-MF",SpecialtyKey:"G5-MF",Mandatory:true,Critical:true},
		},
		"dependencies":[]dhf.DependencyPolicy{},
		"specialties":[]dhf.SpecialtyPolicy{{Key:"G5-SW"},{Key:"G5-MF"}},
	})
	if err!=nil {t.Fatal(err)}
	g5Manifest,err:=json.Marshal(map[string]any{"requirements":[]map[string]any{
		{"id":"REQ-G5-SW","applicability":"applicable","file_id":"dhf_file","version_seq":1,"sha256":fileSHA},
		{"id":"REQ-G5-MF","applicability":"applicable","file_id":"dhf_file","version_seq":1,"sha256":fileSHA},
	}})
	if err!=nil {t.Fatal(err)}
	exec("INSERT INTO dhf_pilot_templates(id,stage_id,policy_body,policy_sha,status,approved_by,approved_at) VALUES('dhf_g5_tpl','G5',$1,$2,'published',$3,now())",g5Policy,sha(g5Policy),actorID)
	exec("INSERT INTO dhf_pilot_baselines(project_id,stage_id,template_id,active) VALUES('dhf_project','G5','dhf_g5_tpl',true)")
	for _,a:=range [][2]string{{"G5-SW","dhf_sw_reviewer"},{"G5-MF","dhf_mf_reviewer"},{"__gate__","dhf_gate_reviewer"}} {
		exec("INSERT INTO dhf_pilot_review_assignments(project_id,stage_id,review_key,reviewer_id,configured_by) VALUES('dhf_project','G5',$1,$2,$3)",a[0],a[1],actorID)
	}
	seedG5:=func(id string){
		t.Helper()
		exec("INSERT INTO dhf_pilot_attempts(id,project_id,stage_id,template_id,manifest_body,manifest_sha,created_by) VALUES($1,'dhf_project','G5','dhf_g5_tpl',$2,$3,$4)",id,g5Manifest,sha(g5Manifest),actorID)
	}
	seedG5("dhf_g5_attempt")
	g5Result,g5Err:=service.DHFPilotSubmit(ctx,actor,"dhf_g5_attempt","dhf-g5-reviewed-0001")
	if g5Err!=nil || g5Result.Verdict!=dhf.Allow {t.Fatalf("G5 submit denied: %+v %v",g5Result,g5Err)}
	if err=pool.QueryRow(ctx,"SELECT count(*) FROM dhf_pilot_workbench_tasks WHERE submission_id=$1",g5Result.SubmissionID).Scan(&count);err!=nil || count!=3 {
		t.Fatalf("expected two specialties + total Gate: %d %v",count,err)
	}
	for _,tc:=range [][2]string{{"G5-SW","dhf_sw_reviewer"},{"G5-MF","dhf_mf_reviewer"},{"__gate__","dhf_gate_reviewer"}} {
		if err=pool.QueryRow(ctx,"SELECT count(*) FROM dhf_pilot_workbench_tasks WHERE submission_id=$1 AND review_key=$2 AND reviewer_id=$3",g5Result.SubmissionID,tc[0],tc[1]).Scan(&count);err!=nil || count!=1 {
			t.Fatalf("missing G5 reviewer %s: %d %v",tc[0],count,err)
		}
	}
	inbox,inboxErr:=service.DHFPilotWorkbenchInbox(ctx,domain.User{ID:"dhf_sw_reviewer"})
	if inboxErr!=nil || len(inbox)!=1 || inbox[0].ReviewKey!="G5-SW" || inbox[0].SubmissionID!=g5Result.SubmissionID {
		t.Fatalf("wrong specialty inbox: %+v %v",inbox,inboxErr)
	}
	otherInbox,inboxErr:=service.DHFPilotWorkbenchInbox(ctx,domain.User{ID:"dhf_mf_reviewer"})
	if inboxErr!=nil || len(otherInbox)!=1 || otherInbox[0].ReviewKey!="G5-MF" {
		t.Fatalf("G5 tasks leaked across assignees: %+v %v",otherInbox,inboxErr)
	}
	seedG5("dhf_g5_unassigned")
	if _, deleteErr:=pool.Exec(ctx,"DELETE FROM dhf_pilot_review_assignments WHERE project_id='dhf_project' AND stage_id='G5' AND review_key='G5-MF'");deleteErr==nil {t.Fatal("applied review assignment must not be erased")}
	// G6 first design transfer is a DISTINCT Gate. Unconfigured reviewers
	// must abort the entire submission, and filling the assignment allows a
	// fresh transaction with the SAME idempotency key.
	g6Policy,err:=json.Marshal(map[string]any{
		"stage_id":"G6","conditional_allowed":false,
		"requirements":[]dhf.RequirementPolicy{{ID:"DHF-REQ-001",Mandatory:true,Critical:true}},
		"dependencies":[]dhf.DependencyPolicy{},
		"specialties":[]dhf.SpecialtyPolicy{},
	})
	if err!=nil {t.Fatal(err)}
	exec("INSERT INTO dhf_pilot_templates(id,stage_id,policy_body,policy_sha,status,approved_by,approved_at) VALUES('dhf_g6_tpl','G6',$1,$2,'published',$3,now())",g6Policy,sha(g6Policy),actorID)
	exec("INSERT INTO dhf_pilot_baselines(project_id,stage_id,template_id,active) VALUES('dhf_project','G6','dhf_g6_tpl',true)")
	exec("INSERT INTO dhf_pilot_attempts(id,project_id,stage_id,template_id,manifest_body,manifest_sha,created_by) VALUES('dhf_g6_attempt','dhf_project','G6','dhf_g6_tpl',$1,$2,$3)",manifestBytes,sha(manifestBytes),actorID)
	missingReviewer,missingReviewerErr:=service.DHFPilotSubmit(ctx,actor,"dhf_g6_attempt","dhf-g6-transfer-0001")
	if missingReviewerErr==nil || missingReviewer.Verdict!=dhf.Deny {
		t.Fatalf("G6 submission without review assignment must fail: %+v %v",missingReviewer,missingReviewerErr)
	}
	if err=pool.QueryRow(ctx,"SELECT state FROM dhf_pilot_attempts WHERE id='dhf_g6_attempt'").Scan(&state);err!=nil || state!="preparing" {
		t.Fatalf("G6 failed reviewer validation failed to roll back: %q %v",state,err)
	}
	exec("INSERT INTO dhf_pilot_review_assignments(project_id,stage_id,review_key,reviewer_id,configured_by) VALUES('dhf_project','G6','__gate__','dhf_gate_reviewer',$1)",actorID)
	g6Result,g6Err:=service.DHFPilotSubmit(ctx,actor,"dhf_g6_attempt","dhf-g6-transfer-0001")
	if g6Err!=nil || g6Result.Verdict!=dhf.Allow {t.Fatalf("configured G6 gate submit: %+v %v",g6Result,g6Err)}
	if err=pool.QueryRow(ctx,"SELECT count(*) FROM dhf_pilot_workbench_tasks WHERE submission_id=$1 AND stage_id='G6' AND review_key='__gate__' AND reviewer_id='dhf_gate_reviewer'",g6Result.SubmissionID).Scan(&count);err!=nil || count!=1 {
		t.Fatalf("G6 Gate task was not created atomically: %d %v",count,err)
	}
	// Real physical tampering must be detected even if DB Blob rows and
	// immutable file_versions still report the original checksum.
	path,err:=physicalStore.PathFor(storageKey)
	if err!=nil {t.Fatal(err)}
	if err=os.WriteFile(path,[]byte("XXX pilot immutable evidence bytes"),0600);err!=nil {t.Fatal(err)}
	seedAttempt("dhf_attempt_tamper")
	tampered,submitErr:=service.DHFPilotSubmit(ctx,actor,"dhf_attempt_tamper","dhf-isolated-tamper-0001")
	if submitErr!=nil || tampered.Verdict!=dhf.Deny ||
		!slices.Contains(tampered.ReasonCodes,"DHF_EVIDENCE_BYTES_INVALID") {
		t.Fatalf("physically altered evidence was accepted: %+v %v",tampered,submitErr)
	}
	if err=os.WriteFile(path,content,0600);err!=nil {t.Fatal(err)}
	// Negative security scenario: losing the original file grant denies new
	// submissions even when project membership and a valid manifest remain.
	exec("DELETE FROM acls WHERE id='dhf_acl'")
	seedAttempt("dhf_attempt_2")
	denied,err:=service.DHFPilotSubmit(ctx,domain.User{ID:actorID},"dhf_attempt_2","dhf-isolated-idempotency-0003")
	if err!=nil || denied.Verdict!=dhf.Deny {t.Fatalf("revoked ACL was not enforced: %+v %v",denied,err)}
	err=pool.QueryRow(ctx,"SELECT count(*) FROM dhf_pilot_submissions WHERE attempt_id='dhf_attempt_2'").Scan(&count)
	if err!=nil || count!=0 {t.Fatalf("denied submit had DB side effects: %d %v",count,err)}
	// The new bidirectional invariant blocks a "submitted" state that has
	// no corresponding immutable journal entry.
	seedAttempt("dhf_attempt_3")
	if _, err := pool.Exec(ctx,
		"UPDATE dhf_pilot_attempts SET state='submitted' WHERE id='dhf_attempt_3'"); err == nil {
		t.Fatal("unsigned standalone submitted state was accepted")
	}
	if err=pool.QueryRow(ctx,
		"SELECT state FROM dhf_pilot_attempts WHERE id='dhf_attempt_3'").Scan(&state); err!=nil || state!="preparing" {
		t.Fatalf("standalone submitted state was not rolled back: %q %v",state,err)
	}
	// A fabricated journal with correct attempt/role but the wrong policy
	// digest must roll back its attempt transition and journal atomically.
	tx,err:=pool.Begin(ctx)
	if err!=nil {t.Fatal(err)}
	_,err=tx.Exec(ctx,"UPDATE dhf_pilot_attempts SET state='submitted' WHERE id='dhf_attempt_3'")
	if err!=nil { _=tx.Rollback(ctx);t.Fatal(err)}
	_,err=tx.Exec(ctx, "INSERT INTO dhf_pilot_submissions(id,attempt_id,project_id,stage_id,template_id,submitted_by,idempotency_key,request_sha,policy_sha,manifest_sha) VALUES('forged-sub','dhf_attempt_3','dhf_project','G1','dhf_tpl',$1,'forged-policy-key-0001',$2,$3,$4)",
		actorID,strings.Repeat("b",64),strings.Repeat("e",64),sha(manifestBytes))
	if err!=nil { _=tx.Rollback(ctx);t.Fatal(err)}
	if err=tx.Commit(ctx);err==nil {t.Fatal("wrong template digest accepted at commit")}
	if err=pool.QueryRow(ctx,"SELECT state FROM dhf_pilot_attempts WHERE id='dhf_attempt_3'").Scan(&state);err!=nil || state!="preparing" {
		t.Fatalf("forged commit modified frozen state %q %v",state,err)
	}
	if err=pool.QueryRow(ctx,"SELECT count(*) FROM dhf_pilot_submissions WHERE id='forged-sub'").Scan(&count);err!=nil || count!=0 {
		t.Fatalf("forged submission was persisted: %d %v",count,err)
	}
	// A DB reference must prohibit gc_pending and DELETE, even if an operator
	// attempts manual SQL after submission; unreferenced blobs are unaffected.
	if _, err:=pool.Exec(ctx,"UPDATE blobs SET state='gc_pending' WHERE id='dhf_blob'"); err==nil {
		t.Fatal("DHF referenced blob entered gc_pending")
	}
	if _, err:=pool.Exec(ctx,"DELETE FROM blobs WHERE id='dhf_blob'"); err==nil {
		t.Fatal("DHF referenced blob was deleted")
	}
	for _,statement:=range []string{
		"UPDATE blobs SET storage_key='ready/ff/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' WHERE id='dhf_blob'",
		"UPDATE blobs SET sha256=repeat('f',64) WHERE id='dhf_blob'",
		"UPDATE blobs SET size_bytes=999 WHERE id='dhf_blob'",
	} {
		if _,err:=pool.Exec(ctx,statement);err==nil {
			t.Fatalf("referenced Blob identity was mutated: %s",statement)
		}
	}
	if _, err:=pool.Exec(ctx,"UPDATE dhf_pilot_attempts SET state='reviewing' WHERE id='dhf_attempt_1'"); err==nil {
		t.Fatal("pilot accepted unimplemented review state")
	}
	fmt.Println("DHF_V064_DB_INTEGRATION_PASS")
}


// Same interface adaptation as cmd/server: Stage exposes the ports contract,
// while Open remains the production BlobStore implementation.
type dhfTestBlobAdapter struct { *blob.Store }
func (a dhfTestBlobAdapter) Stage() (ports.BlobStage,error) { return a.Store.Stage() }
