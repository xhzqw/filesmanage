package postgres

import (
	"context"
	"errors"
	"fmt"
	"filesmanage/internal/ports"
	"sort"

	"github.com/jackc/pgx/v5"
)

// Compile-time check; these commands are available only on a transaction
// handle. The HTTP layer has no route to this experimental submit method.
var _ ports.DHFPilotSubmissionStore = (*Repository)(nil)

func (r *Repository) DHFPilotBeginSubmission(ctx context.Context) error {
	if _, ok := r.Q.(pgx.Tx); !ok {
		return errors.New("DHF submission requires one write transaction")
	}
	// All policy, ACL, evidence and entitlement reads are repeated INSIDE this
	// serializable write transaction. A prior preflight is never sufficient.
	_, err := r.Q.Exec(ctx, "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
	return err
}

// Lock project, stage baseline, then attempt, in that order. The first
// lookup merely discovers lock keys; it never authorizes or returns data.
func (r *Repository) DHFPilotLockAttempt(ctx context.Context, attemptID string) error {
	var projectID,stageID,stringID string
	err := r.Q.QueryRow(ctx,"SELECT project_id,stage_id FROM dhf_pilot_attempts WHERE id=$1",attemptID).
		Scan(&projectID,&stageID)
	if errors.Is(err,pgx.ErrNoRows) { return ports.ErrRowMissing }
	if err != nil { return err }
	err = r.Q.QueryRow(ctx,"SELECT id FROM dhf_pilot_projects WHERE id=$1 FOR UPDATE",projectID).Scan(&stringID)
	if err != nil { return err }
	err = r.Q.QueryRow(ctx,"SELECT project_id FROM dhf_pilot_baselines WHERE project_id=$1 AND stage_id=$2 FOR UPDATE",projectID,stageID).Scan(&stringID)
	if err != nil { return err }
	err = r.Q.QueryRow(ctx,"SELECT id FROM dhf_pilot_attempts WHERE id=$1 AND project_id=$2 AND stage_id=$3 FOR UPDATE",attemptID,projectID,stageID).Scan(&stringID)
	if errors.Is(err,pgx.ErrNoRows) { return ports.ErrRowMissing }
	return err
}

func (r *Repository) DHFPilotSubmissionForAttempt(ctx context.Context, attemptID string) (ports.DHFPilotSubmissionRecord,error) {
	var record ports.DHFPilotSubmissionRecord
	err := r.Q.QueryRow(ctx, "SELECT id,attempt_id,project_id,stage_id,template_id,submitted_by,idempotency_key,request_sha,policy_sha,manifest_sha FROM dhf_pilot_submissions WHERE attempt_id=$1",attemptID).
		Scan(&record.ID,&record.AttemptID,&record.ProjectID,&record.StageID,&record.TemplateID,
			&record.SubmittedBy,&record.IdempotencyKey,&record.RequestSHA,&record.PolicySHA,&record.ManifestSHA)
	if errors.Is(err,pgx.ErrNoRows) { return record,ports.ErrRowMissing }
	return record,err
}

func (r *Repository) DHFPilotPersistSubmission(ctx context.Context, record ports.DHFPilotSubmissionRecord, pins []ports.DHFPilotEvidencePin) error {
	if record.AttemptID=="" || record.ProjectID=="" || record.TemplateID=="" || record.SubmittedBy=="" {
		return errors.New("DHF submission identity missing")
	}
	// Lock referenced blob rows in a deterministic order. Physical BlobStore
	// GC integration is still required before using this outside a pilot.
	blobIDs:=make([]string,0,len(pins))
	seen:=map[string]bool{}
	for _,pin:=range pins {
		if !seen[pin.BlobID] {
			seen[pin.BlobID]=true
			blobIDs=append(blobIDs,pin.BlobID)
		}
	}
	sort.Strings(blobIDs)
	for _,id:=range blobIDs {
		var locked string
		err:=r.Q.QueryRow(ctx,"SELECT id FROM blobs WHERE id=$1 AND state='ready' FOR SHARE",id).Scan(&locked)
		if err!=nil{return fmt.Errorf("DHF evidence blob unavailable: %w",err)}
	}
	// CAS prevents duplicate submission of a single attempt and prevents a
	// stale manifest from being accepted after a concurrent draft edit.
	tag,err:=r.Q.Exec(ctx,"UPDATE dhf_pilot_attempts SET state='submitted' WHERE id=$1 AND project_id=$2 AND stage_id=$3 AND template_id=$4 AND state='preparing' AND manifest_sha=$5",
		record.AttemptID,record.ProjectID,record.StageID,record.TemplateID,record.ManifestSHA)
	if err!=nil{return err}
	if tag.RowsAffected()!=1{return errors.New("DHF attempt state or manifest changed concurrently")}
	_,err=r.Q.Exec(ctx, "INSERT INTO dhf_pilot_submissions(id,attempt_id,project_id,stage_id,template_id,submitted_by,idempotency_key,request_sha,policy_sha,manifest_sha) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
		record.ID,record.AttemptID,record.ProjectID,record.StageID,record.TemplateID,
		record.SubmittedBy,record.IdempotencyKey,record.RequestSHA,record.PolicySHA,record.ManifestSHA)
	if err!=nil{return err}
	// Record only the exact confirmed version; the database composite FK
	// checks the file ID, version sequence, blob ID and SHA as one tuple.
	for _,pin:=range pins {
		_,err=r.Q.Exec(ctx,"INSERT INTO dhf_pilot_submission_evidence(submission_id,requirement_id,file_id,version_seq,blob_id,sha256) VALUES($1,$2,$3,$4,$5,$6)",
			record.ID,pin.RequirementID,pin.FileID,pin.VersionSeq,pin.BlobID,pin.Sha256)
		if err!=nil{return err}
	}
	// Append audit in this same transaction; rollback removes all changes.
	_,err=r.Q.Exec(ctx, "INSERT INTO audit_events(actor_id,event_type,target_kind,target_id,request_id,outcome,details) VALUES($1,'dhf.pilot.submitted','dhf_attempt',$2,$3,'success',jsonb_build_object('submissionId',$4,'manifestSha',$5,'policySha',$6))",
		record.SubmittedBy,record.AttemptID,record.IdempotencyKey,record.ID,record.ManifestSHA,record.PolicySHA)
	return err
}
