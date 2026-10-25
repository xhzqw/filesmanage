package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/domain/dhf"
	"filesmanage/internal/ports"
	"slices"
	"testing"
	"time"
)

type pilotUOW struct { record ports.DHFPilotAttemptRecord; errorOnLoad error; predecessor dhf.StageState; authoritativeDisabled bool }
func (u *pilotUOW) Begin(context.Context) (ports.Tx,error) {
	return &pilotTx{uow:u},nil
}
type pilotTx struct {
	ports.Tx // unused repository methods must never be touched in no-evidence fixtures
	uow *pilotUOW
}
func (t *pilotTx) Commit(context.Context) error { return errors.New("pilot preflight cannot commit") }
func (t *pilotTx) Rollback(context.Context) error { return nil }
func (t *pilotTx) UserByID(_ context.Context,id string)(domain.User,error){
	u:=domain.User{ID:id,IsAdmin:false}
	if t.uow.authoritativeDisabled {
		now:=testNowForPilot()
		u.DisabledAt=&now
	}
	return u,nil
}
func testNowForPilot()time.Time{return time.Date(2026,10,24,12,0,0,0,time.UTC)}
func (t *pilotTx) DHFPilotBeginSnapshot(context.Context) error { return nil }
func (t *pilotTx) DHFPilotAttemptForActor(_ context.Context, _, _ string) (ports.DHFPilotAttemptRecord,error) {
	if t.uow.errorOnLoad != nil { return ports.DHFPilotAttemptRecord{},t.uow.errorOnLoad }
	return t.uow.record,nil
}
func (t *pilotTx) DHFPilotPredecessor(context.Context,string,string)(dhf.StageState,error){
	return t.uow.predecessor,nil
}

func pilotTestService(t *testing.T, mandatory bool) (*Service,*pilotUOW) {
	t.Helper()
	policy := dhfPilotPolicyDocument{
		StageID:"G1",
		Requirements:[]dhf.RequirementPolicy{{ID:"REQ-1",Mandatory:mandatory}},
	}
	manifest := dhfPilotManifest{
		Requirements:[]dhfPilotEvidence{{ID:"REQ-1",Applicability:dhf.Applicable}},
	}
	p,err:=json.Marshal(policy)
	if err!=nil {t.Fatal(err)}
	m,err:=json.Marshal(manifest)
	if err!=nil {t.Fatal(err)}
	sum:=func(b []byte)string{h:=sha256.Sum256(b);return hex.EncodeToString(h[:])}
	u:=&pilotUOW{
		predecessor:dhf.Preparing,
		record:ports.DHFPilotAttemptRecord{
			ProjectID:"proj",StageID:"G1",AttemptID:"attempt",TemplateVersionID:"tpl1",
			PolicyBody:p,PolicyHash:sum(p),PolicyStatus:"published",TemplateApproved:true,
			ManifestBody:m,ManifestHash:sum(m),State:dhf.Preparing,
			ProjectState:"active",BaselineActive:true,CanPrepare:true,CanSubmit:true,
		},
	}
	return &Service{uow:u,now:func()time.Time{return time.Date(2026,10,24,12,0,0,0,time.UTC)}},u
}

func TestDHFPreflightIsAlwaysAdvisory(t *testing.T){
	s,_:=pilotTestService(t,false)
	out,err:=s.DHFPilotPreflight(context.Background(),domain.User{ID:"user"},"attempt",dhf.ActionSubmit)
	if err!=nil {t.Fatal(err)}
	if !out.AdvisoryOnly || out.Decision.Verdict!=dhf.Allow {
		t.Fatalf("expected advisory-only nonmandatory submit: %+v",out)
	}
}

func TestDHFPilotBlocksMissingMandatoryEvidence(t *testing.T){
	s,_:=pilotTestService(t,true)
	out,err:=s.DHFPilotPreflight(context.Background(),domain.User{ID:"user"},"attempt",dhf.ActionSubmit)
	if err!=nil {t.Fatal(err)}
	if out.Decision.Verdict!=dhf.Deny || !slices.Contains(out.Decision.Reasons,"DHF_EVIDENCE_MISSING"){
		t.Fatalf("missing version must deny: %+v",out)
	}
	out,err=s.DHFPilotPreflight(context.Background(),domain.User{ID:"user"},"attempt",dhf.ActionPrepare)
	if err!=nil || out.Decision.Verdict!=dhf.Allow {
		t.Fatalf("reversible draft preparation: %+v %v",out,err)
	}
}

func TestDHFPilotFailClosedMissingAndUnpublishedPolicy(t *testing.T){
	s,u:=pilotTestService(t,false)
	u.record.PolicyStatus="draft"
	out,err:=s.DHFPilotPreflight(context.Background(),domain.User{ID:"user"},"attempt",dhf.ActionSubmit)
	if err!=nil || out.Decision.Verdict!=dhf.Deny {t.Fatalf("draft policy allowed: %+v %v",out,err)}
	u.record.PolicyStatus="published"
	u.record.PolicyHash="tampered"
	out,err=s.DHFPilotPreflight(context.Background(),domain.User{ID:"user"},"attempt",dhf.ActionSubmit)
	if err!=nil || !slices.Contains(out.Decision.Reasons,"DHF_SOURCE_HASH_MISMATCH"){
		t.Fatalf("tampered policy allowed: %+v %v",out,err)
	}
}

func TestDHFPilotDenyUnauthorizedOrPrivilegedAction(t *testing.T){
	s,u:=pilotTestService(t,false)
	for _, action:=range []dhf.Action{dhf.ActionFinalize,dhf.ActionConditionalApprove,dhf.ActionIssueDocument} {
		out,err:=s.DHFPilotPreflight(context.Background(),domain.User{ID:"user"},"attempt",action)
		if err!=nil || out.Decision.Verdict!=dhf.Deny || !slices.Contains(out.Decision.Reasons,"DHF_PILOT_ACTION_DISABLED"){
			t.Fatalf("privileged action %s: %+v %v",action,out,err)
		}
	}
	u.record.CanSubmit=false
	out,err:=s.DHFPilotPreflight(context.Background(),domain.User{ID:"user"},"attempt",dhf.ActionSubmit)
	if err!=nil || !slices.Contains(out.Decision.Reasons,"DHF_SCOPE_DENIED"){
		t.Fatalf("missing project capability: %+v %v",out,err)
	}
}

func TestDHFPilotMissingPredecessorIsNotAccepted(t *testing.T){
	s,u:=pilotTestService(t,false)
	var policy dhfPilotPolicyDocument
	if err:=json.Unmarshal(u.record.PolicyBody,&policy);err!=nil{t.Fatal(err)}
	policy.Dependencies=[]dhf.DependencyPolicy{{ID:"G0-input",PredecessorStage:"G0",GuardedAction:dhf.ActionSubmit}}
	data,err:=json.Marshal(policy)
	if err!=nil{t.Fatal(err)}
	u.record.PolicyBody=data
	sum:=sha256.Sum256(data);u.record.PolicyHash=hex.EncodeToString(sum[:])
	u.predecessor=dhf.Preparing
	out,err:=s.DHFPilotPreflight(context.Background(),domain.User{ID:"user"},"attempt",dhf.ActionSubmit)
	if err!=nil || out.Decision.Verdict!=dhf.Deny || !slices.Contains(out.Decision.Reasons,"DHF_UPSTREAM_BLOCKED"){
		t.Fatalf("unaccepted predecessor: %+v %v",out,err)
	}
}

func TestDHFPilotJSONRejectsUnknownFieldsAndTrailingValues(t *testing.T) {
	var manifest dhfPilotManifest
	if decodePilotJSON([]byte(`{"requirements":[],"unknown":"extra"}`),&manifest)==nil{
		t.Fatal("unexpected JSON fields must fail")
	}
	if decodePilotJSON([]byte(`{"requirements":[]} {"requirements":[]}`),&manifest)==nil{
		t.Fatal("multiple top-level JSON values must fail")
	}
}

func TestDHFPilotUnavailableAdapterFailsClosed(t *testing.T) {
	s:=&Service{uow:&unsupportedPilotUOW{}}
	out,err:=s.DHFPilotPreflight(context.Background(),domain.User{ID:"user"},"attempt",dhf.ActionPrepare)
	if err==nil || out.Decision.Verdict!=dhf.Deny {t.Fatalf("unsupported adapter: %+v %v",out,err)}
}
type unsupportedPilotUOW struct{}
func (*unsupportedPilotUOW) Begin(context.Context)(ports.Tx,error){return &unsupportedPilotTx{},nil}
type unsupportedPilotTx struct{ports.Tx}
func (*unsupportedPilotTx) Rollback(context.Context)error{return nil}
func (*unsupportedPilotTx) Commit(context.Context)error{return nil}


func TestDHFPilotRejectsOmittedMandatoryBooleanEvenWithMatchingHash(t *testing.T) {
	s,u:=pilotTestService(t,false)
	// A policy body that omits Mandatory must not be interpreted as a valid
	// optional deliverable, even when the stored hash matches its bytes.
	policy := []byte(`{"stage_id":"G1","conditional_allowed":false,"requirements":[{"ID":"REQ-1","Critical":false,"ConditionEligible":false,"AllowNotApplicable":false}],"dependencies":null,"specialties":null}`)
	sum:=sha256.Sum256(policy)
	u.record.PolicyBody=policy
	u.record.PolicyHash=hex.EncodeToString(sum[:])
	out,err:=s.DHFPilotPreflight(context.Background(),domain.User{ID:"user"},"attempt",dhf.ActionSubmit)
	if err!=nil || out.Decision.Verdict!=dhf.Deny || !slices.Contains(out.Decision.Reasons,"DHF_POLICY_INVALID"){
		t.Fatalf("missing mandatory boolean must deny: %+v %v",out,err)
	}
}


func TestDHFPilotRejectsDisabledAuthoritativeUser(t *testing.T){
	s,u:=pilotTestService(t,false)
	u.authoritativeDisabled=true
	out,err:=s.DHFPilotPreflight(context.Background(),domain.User{ID:"user",IsAdmin:true},"attempt",dhf.ActionPrepare)
	if err!=nil || out.Decision.Verdict!=dhf.Deny || !slices.Contains(out.Decision.Reasons,"DHF_SCOPE_DENIED"){
		t.Fatalf("caller-supplied admin flag must not override disabled DB user: %+v %v",out,err)
	}
}
