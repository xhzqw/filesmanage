package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"unicode/utf8"
)

// Trial-only reviewer opinion: never legal electronic signing or Gate acceptance.
type DHFPilotRecommendationResult struct {
	TaskID string `json:"taskId"`
	DecisionID string `json:"decisionId"`
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
	Replayed bool `json:"replayed"`
	TrialOnly bool `json:"trialOnly"`
}

func (s *Service) DHFPilotRecommend(ctx context.Context,actor domain.User,taskID,outcome,comment,key string)(DHFPilotRecommendationResult,error){
	fail:=func(code string)DHFPilotRecommendationResult{
		return DHFPilotRecommendationResult{TaskID:taskID,Reason:code,TrialOnly:true}
	}
	if actor.ID=="" || taskID=="" {return fail("DHF_SCOPE_DENIED"),nil}
	if outcome!="recommend_pass" && outcome!="recommend_return" {return fail("DHF_REVIEW_OUTCOME_INVALID"),nil}
	if len(key)<8 || len(key)>160 || strings.TrimSpace(key)!=key {return fail("DHF_IDEMPOTENCY_KEY_INVALID"),nil}
	comment=strings.TrimSpace(comment)
	if utf8.RuneCountInString(comment)>2000 || (outcome=="recommend_return" && comment=="") {
		return fail("DHF_REVIEW_COMMENT_INVALID"),nil
	}
	tx,err:=s.uow.Begin(ctx)
	if err!=nil{return fail("DHF_REVIEW_UNAVAILABLE"),err}
	defer tx.Rollback(ctx)
	store,ok:=any(tx).(ports.DHFPilotRecommendationStore)
	if !ok {return fail("DHF_REVIEW_UNAVAILABLE"),errors.New("DHF review store unavailable")}
	if err=store.DHFPilotBeginSubmission(ctx);err!=nil{return fail("DHF_REVIEW_UNAVAILABLE"),err}
	task,err:=store.DHFPilotReviewTaskForActor(ctx,taskID,actor.ID)
	if errors.Is(err,ports.ErrRowMissing){return fail("DHF_SCOPE_DENIED"),nil}
	if err!=nil{return fail("DHF_REVIEW_UNAVAILABLE"),err}
	auth,err:=tx.UserByID(ctx,actor.ID)
	if err!=nil || auth.ID!=actor.ID || auth.DisabledAt!=nil {return fail("DHF_SCOPE_DENIED"),nil}
	sha:=hashPilotSubmit(taskID,actor.ID,key,outcome,comment)
	existing,err:=store.DHFPilotRecommendationForTask(ctx,taskID)
	if err==nil {
		if existing.ReviewerID==actor.ID && existing.IdempotencyKey==key &&
			existing.RequestSHA==sha && existing.Outcome==outcome &&
			existing.Comment==comment && existing.PolicySHA==task.PolicySHA &&
			existing.ManifestSHA==task.ManifestSHA {
			return DHFPilotRecommendationResult{TaskID:taskID,DecisionID:existing.ID,Status:task.Status,Replayed:true,TrialOnly:true},nil
		}
		return fail("DHF_REVIEW_ALREADY_DECIDED"),nil
	}
	if !errors.Is(err,ports.ErrRowMissing){return fail("DHF_REVIEW_UNAVAILABLE"),err}
	if task.Status!="pending" {return fail("DHF_REVIEW_ALREADY_DECIDED"),nil}
	rec:=ports.DHFPilotRecommendationRecord{
		ID:NewID("dhfrev"),TaskID:taskID,SubmissionID:task.SubmissionID,
		ReviewerID:actor.ID,Outcome:outcome,Comment:comment,IdempotencyKey:key,
		RequestSHA:sha,PolicySHA:task.PolicySHA,ManifestSHA:task.ManifestSHA,
	}
	if err=store.DHFPilotPersistRecommendation(ctx,rec);err!=nil{return fail("DHF_REVIEW_CONFLICT"),err}
	if err=tx.Commit(ctx);err!=nil{return fail("DHF_REVIEW_CONFLICT"),err}
	status:="reviewed"
	if outcome=="recommend_return"{status="returned"}
	return DHFPilotRecommendationResult{TaskID:taskID,DecisionID:rec.ID,Status:status,TrialOnly:true},nil
}
