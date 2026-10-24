package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/domain/dhf"
	"filesmanage/internal/ports"
	"strings"
)

// DHFPilotSubmitOutcome is an INTERNAL pilot-submission outcome. "submitted"
// does NOT mean an approved Gate, a legal DHF acceptance or file release.
type DHFPilotSubmitOutcome struct {
	Verdict dhf.Verdict
	ReasonCodes []string
	AttemptID string
	SubmissionID string
	Replayed bool
	TrialOnly bool
}

// DHFPilotSubmit commits only a frozen submission attempt with a deterministic
// idempotency key and audit record. There is deliberately NO HTTP route to
// this method while template signatures, Blob GC holds and review authority
// remain incomplete. A separate production release cannot call this method.
func (s *Service) DHFPilotSubmit(
	ctx context.Context, actor domain.User, attemptID, idempotencyKey string,
) (DHFPilotSubmitOutcome,error) {
	denied:=func(code string) DHFPilotSubmitOutcome {
		return DHFPilotSubmitOutcome{
			Verdict:dhf.Deny,ReasonCodes:[]string{code},
			AttemptID:attemptID,TrialOnly:true,
		}
	}
	if actor.ID=="" || attemptID=="" {
		return denied("DHF_SCOPE_DENIED"),nil
	}
	if len(idempotencyKey)<8 || len(idempotencyKey)>160 ||
		strings.TrimSpace(idempotencyKey)!=idempotencyKey {
		return denied("DHF_IDEMPOTENCY_KEY_INVALID"),nil
	}
	tx,err:=s.uow.Begin(ctx)
	if err!=nil {return denied("DHF_SNAPSHOT_UNAVAILABLE"),err}
	defer tx.Rollback(ctx)

	store,ok:=any(tx).(ports.DHFPilotSubmissionStore)
	if !ok {return denied("DHF_SUBMISSION_STORE_UNAVAILABLE"),errors.New("DHF submission transaction unavailable")}
	if err=store.DHFPilotBeginSubmission(ctx);err!=nil {
		return denied("DHF_SNAPSHOT_UNAVAILABLE"),err
	}
	if err=store.DHFPilotLockAttempt(ctx,attemptID);err!=nil {
		if errors.Is(err,ports.ErrRowMissing){return denied("DHF_SCOPE_DENIED"),nil}
		return denied("DHF_SNAPSHOT_UNAVAILABLE"),err
	}
	// Even idempotent replay must have current authenticated project scope;
	// knowledge of a prior key never creates permission.
	row,err:=store.DHFPilotAttemptForActor(ctx,attemptID,actor.ID)
	if errors.Is(err,ports.ErrRowMissing){return denied("DHF_SCOPE_DENIED"),nil}
	if err!=nil {return denied("DHF_SNAPSHOT_UNAVAILABLE"),err}
	trusted,err:=tx.UserByID(ctx,actor.ID)
	if err!=nil || trusted.ID!=actor.ID || trusted.DisabledAt!=nil || !row.CanSubmit {
		return denied("DHF_SCOPE_DENIED"),nil
	}
	requestSHA:=hashPilotSubmit(attemptID,actor.ID,idempotencyKey,row.PolicyHash,row.ManifestHash)
	previous,err:=store.DHFPilotSubmissionForAttempt(ctx,attemptID)
	if err==nil {
		if previous.SubmittedBy!=actor.ID || previous.IdempotencyKey!=idempotencyKey ||
			previous.RequestSHA!=requestSHA || previous.ManifestSHA!=row.ManifestHash ||
			previous.PolicySHA!=row.PolicyHash || previous.TemplateID!=row.TemplateVersionID {
			return denied("DHF_SUBMISSION_ALREADY_EXISTS"),nil
		}
		return DHFPilotSubmitOutcome{Verdict:dhf.Allow,AttemptID:attemptID,
			SubmissionID:previous.ID,Replayed:true,TrialOnly:true},nil
	}
	if !errors.Is(err,ports.ErrRowMissing) {
		return denied("DHF_SNAPSHOT_UNAVAILABLE"),err
	}
	// Never use the result of a previous read-only preflight as authority.
	checked,verifiedRow,pins,err:=s.dhfPilotEvaluateTx(ctx,tx,store,actor,attemptID,dhf.ActionSubmit)
	if err!=nil {return denied("DHF_SNAPSHOT_UNAVAILABLE"),err}
	if checked.Decision.Verdict!=dhf.Allow {
		return DHFPilotSubmitOutcome{Verdict:dhf.Deny,
			ReasonCodes:checked.Decision.Reasons,AttemptID:attemptID,TrialOnly:true},nil
	}
	if verifiedRow.AttemptID!=row.AttemptID ||
		verifiedRow.ManifestHash!=row.ManifestHash ||
		verifiedRow.PolicyHash!=row.PolicyHash {
		return denied("DHF_SNAPSHOT_IDENTITY_INVALID"),nil
	}
	record:=ports.DHFPilotSubmissionRecord{
		ID:NewID("dhfsub"),AttemptID:attemptID,ProjectID:row.ProjectID,
		StageID:row.StageID,TemplateID:row.TemplateVersionID,
		SubmittedBy:actor.ID,IdempotencyKey:idempotencyKey,
		RequestSHA:requestSHA,PolicySHA:row.PolicyHash,ManifestSHA:row.ManifestHash,
	}
	// Reviewer tasks share this exact transaction and immutable submission.
	// Never generate a G5/G6 review task without an explicitly configured,
	// distinct responsible reviewer. The server re-parses the verified policy.
	var reviewKeys []string
	if row.StageID == "G5" || row.StageID == "G6" {
		var policy dhfPilotPolicyDocument
		if err := decodePilotJSON(row.PolicyBody, &policy); err != nil {
			return denied("DHF_POLICY_INVALID"), nil
		}
		reviewKeys = []string{}
		if row.StageID == "G5" {
			if len(policy.Specialties) == 0 {
				return denied("DHF_SPECIALTY_POLICY_INVALID"), nil
			}
			for _, specialty := range policy.Specialties {
				if specialty.Key == "" || specialty.Key == "__gate__" {
					return denied("DHF_SPECIALTY_POLICY_INVALID"), nil
				}
				reviewKeys = append(reviewKeys, specialty.Key)
			}
		}
		// Source template order is binding; Gate always signs last.
		reviewKeys = append(reviewKeys,"__gate__")
	}
	if err=store.DHFPilotPersistSubmission(ctx,record,pins,reviewKeys);err!=nil {
		// A failed CAS, audit insert, composite FK or unique key rolls back
		// the whole transaction; callers must retry with the SAME key.
		return denied("DHF_SUBMISSION_CONFLICT"),err
	}
	if err=tx.Commit(ctx);err!=nil {
		return denied("DHF_SUBMISSION_CONFLICT"),err
	}
	return DHFPilotSubmitOutcome{Verdict:dhf.Allow,AttemptID:attemptID,
		SubmissionID:record.ID,TrialOnly:true},nil
}

func hashPilotSubmit(attemptID,actorID,key,policySHA,manifestSHA string) string {
	// Length prefixes eliminate concatenation ambiguities even for opaque IDs.
	fields:=[]string{attemptID,actorID,key,policySHA,manifestSHA}
	h:=sha256.New()
	for _,field:=range fields {
		var prefix [8]byte
		size:=uint64(len(field))
		for i:=7;i>=0;i-- {prefix[i]=byte(size);size>>=8}
		_,_=h.Write(prefix[:])
		_,_=h.Write([]byte(field))
	}
	return hex.EncodeToString(h.Sum(nil))
}
