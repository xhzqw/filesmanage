package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

// An independently assigned pilot reviewer can only recommend return/reject.
// Even a successful recommendation NEVER grants formal accepted/conditional
// stage state or initiates corrective work without the existing review chain.
type DHFGateDecisionReviewPage struct {
	Items          []ports.DHFGateDecisionReviewItem `json:"items"`
	TrialOnly      bool                              `json:"trialOnly"`
	FormalAccepted bool                              `json:"formalAccepted"`
}
type DHFGateDecisionReviewInput struct {
	Opinion        string `json:"opinion"`
	Reason         string `json:"reason"`
	Password       string `json:"password"`
	IdempotencyKey string `json:"idempotencyKey"`
}
type DHFGateDecisionReviewOutcome struct {
	OpinionID      string `json:"opinionId,omitempty"`
	ReviewID       string `json:"reviewId"`
	State          string `json:"state,omitempty"`
	Replayed       bool   `json:"replayed"`
	TrialOnly      bool   `json:"trialOnly"`
	FormalAccepted bool   `json:"formalAccepted"`
	Reason         string `json:"reason,omitempty"`
}

func (s *Service) DHFGateDecisionReviewInbox(ctx context.Context, actor domain.User) (DHFGateDecisionReviewPage, error) {
	output := DHFGateDecisionReviewPage{Items: []ports.DHFGateDecisionReviewItem{}, TrialOnly: true}
	if actor.ID == "" {
		return output, nil
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return output, err
	}
	defer tx.Rollback(ctx)
	store, ok := any(tx).(ports.DHFGateDecisionReviewStore)
	if !ok {
		return output, errors.New("DHF independent Gate reviewer port missing")
	}
	if err = store.DHFPilotBeginSubmission(ctx); err != nil {
		return output, err
	}
	output.Items, err = store.DHFGateDecisionReviewInbox(ctx, actor.ID)
	return output, err
}

func (s *Service) DHFGateDecisionReviewRecommend(ctx context.Context, actor domain.User, reviewID string, input DHFGateDecisionReviewInput) (DHFGateDecisionReviewOutcome, error) {
	fail := func(reason string) DHFGateDecisionReviewOutcome {
		return DHFGateDecisionReviewOutcome{ReviewID: reviewID, TrialOnly: true, Reason: reason}
	}
	if actor.ID == "" || reviewID == "" {
		return fail("DHF_SCOPE_DENIED"), nil
	}
	if input.Opinion != "recommend_return" && input.Opinion != "recommend_reject" {
		return fail("DHF_GATE_FORMAL_DECISION_NOT_AUTHORIZED"), nil
	}
	if len(input.Reason) < 10 || len(input.Reason) > 2000 || strings.TrimSpace(input.Reason) != input.Reason {
		return fail("DHF_GATE_OPINION_REASON_INVALID"), nil
	}
	if len(input.IdempotencyKey) < 8 || len(input.IdempotencyKey) > 160 ||
		strings.TrimSpace(input.IdempotencyKey) != input.IdempotencyKey {
		return fail("DHF_IDEMPOTENCY_KEY_INVALID"), nil
	}
	if len(input.Password) == 0 || len(input.Password) > 1024 {
		return fail("DHF_REAUTH_FAILED"), nil
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return fail("DHF_GATE_REVIEW_UNAVAILABLE"), err
	}
	defer tx.Rollback(ctx)
	store, ok := any(tx).(ports.DHFGateDecisionReviewStore)
	if !ok {
		return fail("DHF_GATE_REVIEW_UNAVAILABLE"), errors.New("DHF independent Gate reviewer port missing")
	}
	if err = store.DHFPilotBeginSubmission(ctx); err != nil {
		return fail("DHF_GATE_REVIEW_UNAVAILABLE"), err
	}
	item, err := store.DHFGateDecisionReviewByID(ctx, reviewID, actor.ID)
	if errors.Is(err, ports.ErrRowMissing) {
		return fail("DHF_SCOPE_DENIED"), nil
	}
	if err != nil {
		return fail("DHF_GATE_REVIEW_UNAVAILABLE"), err
	}
	current, err := tx.UserByID(ctx, actor.ID)
	if err != nil || current.ID != actor.ID || current.DisabledAt != nil || current.MustChangePassword ||
		current.Login == "" || current.Login != actor.Login {
		return fail("DHF_SCOPE_DENIED"), nil
	}
	count, err := store.DHFPilotRecentAttestationAuthFailures(ctx, actor.ID)
	if err != nil {
		return fail("DHF_GATE_REVIEW_UNAVAILABLE"), err
	}
	if count >= 5 {
		return fail("DHF_REAUTH_RATE_LIMITED"), nil
	}
	recheck, passwordHash, err := tx.UserByLogin(ctx, current.Login)
	if err != nil || recheck.ID != actor.ID || recheck.MustChangePassword ||
		bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(input.Password)) != nil {
		if err = store.DHFPilotAuditAttestationAuthFailure(ctx, actor.ID, item.SubmissionID); err != nil {
			return fail("DHF_GATE_REVIEW_UNAVAILABLE"), err
		}
		if err = tx.Commit(ctx); err != nil {
			return fail("DHF_GATE_REVIEW_UNAVAILABLE"), err
		}
		return fail("DHF_REAUTH_FAILED"), nil
	}
	// A retry binds the original action/scope, not a possibly rotated
	// mandate. The immutable first opinion retains its original grant ID.
	sum := sha256.Sum256([]byte("DHF-PILOT-INDEPENDENT-GATE-REVIEW-V1\x00" +
		reviewID + "\x00" + actor.ID + "\x00" + input.IdempotencyKey + "\x00" +
		input.Opinion + "\x00" + input.Reason + "\x00" + item.ProjectGraphSHA + "\x00" +
		item.CandidatePayloadSHA))
	requestSHA := hex.EncodeToString(sum[:])
	previous, err := store.DHFGateDecisionReviewOpinionByReview(ctx, reviewID)
	if err == nil {
		if previous.ReviewerID == actor.ID && previous.IdempotencyKey == input.IdempotencyKey &&
			previous.RequestSHA == requestSHA {
			return DHFGateDecisionReviewOutcome{OpinionID: previous.ID, ReviewID: reviewID,
				State: "recommendation_only", Replayed: true, TrialOnly: true}, nil
		}
		return fail("DHF_GATE_OPINION_ALREADY_RECORDED"), nil
	}
	if !errors.Is(err, ports.ErrRowMissing) {
		return fail("DHF_GATE_REVIEW_UNAVAILABLE"), err
	}
	opinion := ports.DHFGateDecisionReviewOpinion{
		ID: NewID("dhfgatedecisionreview"), ReviewID: reviewID, GrantID: item.GrantID,
		ReviewerID: actor.ID, Opinion: input.Opinion, Reason: input.Reason,
		SourceGraphSHA:     item.ProjectGraphSHA,
		SourceCandidateSHA: item.CandidatePayloadSHA,
		IdempotencyKey:     input.IdempotencyKey, RequestSHA: requestSHA, TrialOnly: true,
	}
	if err = store.DHFGateDecisionReviewPersistOpinion(ctx, opinion); err != nil {
		return fail("DHF_GATE_REVIEW_PRECONDITION"), err
	}
	if err = tx.Commit(ctx); err != nil {
		return fail("DHF_GATE_REVIEW_PRECONDITION"), err
	}
	return DHFGateDecisionReviewOutcome{OpinionID: opinion.ID, ReviewID: reviewID,
		State: "recommendation_only", TrialOnly: true}, nil
}
