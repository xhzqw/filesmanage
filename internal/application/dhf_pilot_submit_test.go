package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/domain/dhf"
	"filesmanage/internal/ports"
	"slices"
	"testing"
)

type pilotSubmissionState struct {
	*pilotUOW
	committed *ports.DHFPilotSubmissionRecord
	persistCalls int
	commitCalls int
	failPersist bool
	failCommit bool
}

func makePilotSubmitTest(t *testing.T, mandatory bool) (*Service,*pilotSubmissionState) {
	t.Helper()
	s,seed:=pilotTestService(t,mandatory)
	state:=&pilotSubmissionState{pilotUOW:seed}
	s.uow=state
	return s,state
}
func (s *pilotSubmissionState) Begin(context.Context)(ports.Tx,error) {
	return &pilotSubmissionTx{pilotTx:&pilotTx{uow:s.pilotUOW},state:s},nil
}
type pilotSubmissionTx struct {
	*pilotTx
	state *pilotSubmissionState
	pending *ports.DHFPilotSubmissionRecord
}
func (t *pilotSubmissionTx) DHFPilotBeginSubmission(context.Context)error{return nil}
func (t *pilotSubmissionTx) DHFPilotLockAttempt(_ context.Context,attemptID string)error {
	if attemptID!=t.state.record.AttemptID { return ports.ErrRowMissing }
	return nil
}
func (t *pilotSubmissionTx) DHFPilotSubmissionForAttempt(context.Context,string)(ports.DHFPilotSubmissionRecord,error) {
	if t.state.committed==nil {return ports.DHFPilotSubmissionRecord{},ports.ErrRowMissing}
	return *t.state.committed,nil
}
func (t *pilotSubmissionTx) DHFPilotPersistSubmission(_ context.Context,r ports.DHFPilotSubmissionRecord,pins []ports.DHFPilotEvidencePin,keys []string)error {
	t.state.persistCalls++
	if t.state.failPersist {return errors.New("injected store failure")}
	if len(pins)!=0 {return errors.New("fixture unexpectedly contained pins")}
	if t.state.record.State!=dhf.Preparing {return errors.New("attempt no longer preparing")}
	t.pending=&r
	return nil
}
func (t *pilotSubmissionTx) Commit(context.Context)error {
	t.state.commitCalls++
	if t.state.failCommit {return errors.New("injected commit failure")}
	if t.pending!=nil {
		t.state.committed=t.pending
		t.state.record.State=dhf.Submitted
	}
	return nil
}
func (t *pilotSubmissionTx) Rollback(context.Context)error{
	t.pending=nil
	return nil
}

func TestDHFPilotSubmitIdempotentSingleAttempt(t *testing.T){
	s,db:=makePilotSubmitTest(t,false)
	user:=domain.User{ID:"user"}
	first,err:=s.DHFPilotSubmit(context.Background(),user,"attempt","pilot-test-idempotency-0001")
	if err!=nil || first.Verdict!=dhf.Allow || first.Replayed ||
		first.SubmissionID=="" || !first.TrialOnly {
		t.Fatalf("first pilot submit: %+v %v",first,err)
	}
	second,err:=s.DHFPilotSubmit(context.Background(),user,"attempt","pilot-test-idempotency-0001")
	if err!=nil || second.Verdict!=dhf.Allow || !second.Replayed ||
		second.SubmissionID!=first.SubmissionID {
		t.Fatalf("idempotent replay: %+v %v",second,err)
	}
	if db.persistCalls!=1 || db.commitCalls!=1 {
		t.Fatalf("duplicate write persist=%d commit=%d",db.persistCalls,db.commitCalls)
	}
	other,err:=s.DHFPilotSubmit(context.Background(),user,"attempt","pilot-test-idempotency-0002")
	if err!=nil || other.Verdict!=dhf.Deny ||
		!slices.Contains(other.ReasonCodes,"DHF_SUBMISSION_ALREADY_EXISTS"){
		t.Fatalf("different key unexpectedly reused: %+v %v",other,err)
	}
}

func TestDHFPilotSubmitCannotBypassMissingMandatoryEvidence(t *testing.T){
	s,db:=makePilotSubmitTest(t,true)
	got,err:=s.DHFPilotSubmit(context.Background(),domain.User{ID:"user"},"attempt","pilot-test-idempotency-0001")
	if err!=nil || got.Verdict!=dhf.Deny ||
		!slices.Contains(got.ReasonCodes,"DHF_EVIDENCE_MISSING") ||
		db.persistCalls!=0 || db.commitCalls!=0 {
		t.Fatalf("mandatory evidence bypass: %+v %v",got,err)
	}
}

func TestDHFPilotSubmitFailsClosedForUnpublishedOrUntrustedIdentity(t *testing.T){
	s,db:=makePilotSubmitTest(t,false)
	db.record.PolicyStatus="draft"
	got,err:=s.DHFPilotSubmit(context.Background(),domain.User{ID:"user"},"attempt","pilot-test-idempotency-0001")
	if err!=nil || got.Verdict!=dhf.Deny ||
		!slices.Contains(got.ReasonCodes,"DHF_POLICY_UNPUBLISHED"){
		t.Fatalf("unpublished template: %+v %v",got,err)
	}
	db.record.PolicyStatus="published"
	db.record.CanSubmit=false
	got,err=s.DHFPilotSubmit(context.Background(),domain.User{ID:"user",IsAdmin:true},"attempt","pilot-test-idempotency-0001")
	if err!=nil || got.Verdict!=dhf.Deny || !slices.Contains(got.ReasonCodes,"DHF_SCOPE_DENIED"){
		t.Fatalf("client-supplied admin override: %+v %v",got,err)
	}
	if db.persistCalls!=0 {t.Fatalf("unauthorized persisted: %d",db.persistCalls)}
}

func TestDHFPilotSubmitRequiresValidKey(t *testing.T){
	s,db:=makePilotSubmitTest(t,false)
	for _,key:=range []string{"short"," invalid-key ",""}{
		got,err:=s.DHFPilotSubmit(context.Background(),domain.User{ID:"user"},"attempt",key)
		if err!=nil || got.Verdict!=dhf.Deny ||
			!slices.Contains(got.ReasonCodes,"DHF_IDEMPOTENCY_KEY_INVALID"){
			t.Fatalf("key=%q: %+v %v",key,got,err)
		}
	}
	if db.persistCalls!=0 {t.Fatal("invalid key caused a write")}
}

func TestDHFPilotSubmitStoreFailureRollsBack(t *testing.T){
	s,db:=makePilotSubmitTest(t,false)
	db.failPersist=true
	got,err:=s.DHFPilotSubmit(context.Background(),domain.User{ID:"user"},"attempt","pilot-test-idempotency-0001")
	if err==nil || got.Verdict!=dhf.Deny || db.committed!=nil ||
		db.record.State!=dhf.Preparing {
		t.Fatalf("persist failure must roll back: %+v %v",got,err)
	}
	db.failPersist=false
	db.failCommit=true
	got,err=s.DHFPilotSubmit(context.Background(),domain.User{ID:"user"},"attempt","pilot-test-idempotency-0001")
	if err==nil || got.Verdict!=dhf.Deny || db.committed!=nil ||
		db.record.State!=dhf.Preparing {
		t.Fatalf("commit failure must not claim success: %+v %v",got,err)
	}
}

func TestDHFPilotSubmitWrongAttemptAndDisabledUser(t *testing.T){
	s,db:=makePilotSubmitTest(t,false)
	got,err:=s.DHFPilotSubmit(context.Background(),domain.User{ID:"user"},"wrong-attempt","pilot-test-idempotency-0001")
	if err!=nil || got.Verdict!=dhf.Deny {t.Fatalf("wrong attempt: %+v %v",got,err)}
	db.authoritativeDisabled=true
	got,err=s.DHFPilotSubmit(context.Background(),domain.User{ID:"user"},"attempt","pilot-test-idempotency-0001")
	if err!=nil || got.Verdict!=dhf.Deny || !slices.Contains(got.ReasonCodes,"DHF_SCOPE_DENIED"){
		t.Fatalf("disabled principal: %+v %v",got,err)
	}
}

func TestDHFPilotSubmitHashUnambiguous(t *testing.T) {
	a:=hashPilotSubmit("ab","c","defghijk","policy","manifest")
	b:=hashPilotSubmit("a","bc","defghijk","policy","manifest")
	if a==b || len(a)!=64 {t.Fatal("length-prefixed idempotency hash is invalid")}
}
