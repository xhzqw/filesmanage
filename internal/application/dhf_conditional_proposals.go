package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"sort"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type DHFConditionalProposalCatalog struct {
	Options        []ports.DHFConditionalPlanOption `json:"options"`
	Plans          []ports.DHFConditionalProposal   `json:"plans"`
	TrialOnly      bool                             `json:"trialOnly"`
	FormalAccepted bool                             `json:"formalAccepted"`
}
type DHFConditionalProposalInput struct {
	ProjectID      string                           `json:"projectId"`
	StageID        string                           `json:"stageId"`
	DependencyID   string                           `json:"dependencyId"`
	Obligations    []ports.DHFConditionalObligation `json:"obligations"`
	Reason         string                           `json:"reason"`
	ExpiresAt      time.Time                        `json:"expiresAt"`
	Password       string                           `json:"password"`
	IdempotencyKey string                           `json:"idempotencyKey"`
}
type DHFConditionalWithdrawalInput struct {
	Reason   string `json:"reason"`
	Password string `json:"password"`
}
type DHFConditionalProposalOutcome struct {
	ID             string `json:"id,omitempty"`
	Status         string `json:"status,omitempty"`
	Replayed       bool   `json:"replayed"`
	TrialOnly      bool   `json:"trialOnly"`
	FormalAccepted bool   `json:"formalAccepted"`
	Reason         string `json:"reason,omitempty"`
}

func dhfConditionalOption(source ports.DHFConditionalPolicySource) ([]ports.DHFConditionalPlanOption, error) {
	var policy dhfPilotPolicyDocument
	if err := decodePilotJSON(source.PolicyBody, &policy); err != nil {
		return nil, err
	}
	if !checkPilotHash(source.PolicyBody, source.PolicySHA) || policy.StageID != source.StageID {
		return nil, errors.New("DHF conditional proposal policy hash or stage mismatch")
	}
	if !policy.ConditionalAllowed {
		return nil, nil
	}
	allowed := []string{}
	for _, r := range policy.Requirements {
		if r.Mandatory && !r.Critical && r.ConditionEligible {
			allowed = append(allowed, r.ID)
		}
	}
	sort.Strings(allowed)
	if len(allowed) == 0 {
		return nil, nil
	}
	for _, node := range source.Graph {
		if node.StageID != source.StageID || node.PolicySHA != source.PolicySHA ||
			node.TemplateID != source.TemplateID || !node.ConditionalTemplateFlag {
			continue
		}
		options := []ports.DHFConditionalPlanOption{}
		for _, edge := range node.Dependencies {
			if edge.AllowConditional && (edge.GuardedAction == "prepare" || edge.GuardedAction == "submit") {
				// Accepted predecessors never need a conditional exception.
				alreadyAccepted := false
				for _, predecessor := range source.Graph {
					if predecessor.StageID == edge.PredecessorStage && predecessor.PositionState == "accepted" {
						alreadyAccepted = true
						break
					}
				}
				if alreadyAccepted {
					continue
				}
				options = append(options, ports.DHFConditionalPlanOption{ProjectID: source.ProjectID,
					StageID: source.StageID, TemplateID: source.TemplateID, DependencyID: edge.ID,
					PredecessorStage: edge.PredecessorStage, GuardedAction: edge.GuardedAction,
					EligibleRequirements: allowed, EligibleOwners: source.Owners})
			}
		}
		return options, nil
	}
	return nil, errors.New("conditional policy is not in the published project graph")
}

func (s *Service) DHFConditionalProposalCatalog(ctx context.Context, actor domain.User) (DHFConditionalProposalCatalog, error) {
	output := DHFConditionalProposalCatalog{Options: []ports.DHFConditionalPlanOption{},
		Plans: []ports.DHFConditionalProposal{}, TrialOnly: true}
	if actor.ID == "" {
		return output, nil
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return output, err
	}
	defer tx.Rollback(ctx)
	store, ok := any(tx).(ports.DHFConditionalProposalStore)
	if !ok {
		return output, errors.New("DHF conditional proposal store unavailable")
	}
	if err = store.DHFPilotBeginSubmission(ctx); err != nil {
		return output, err
	}
	sources, err := store.DHFConditionalPoliciesForActor(ctx, actor.ID)
	if err != nil {
		return output, err
	}
	for _, source := range sources {
		eligible, err := dhfConditionalOption(source)
		if err != nil {
			return output, err
		}
		output.Options = append(output.Options, eligible...)
	}
	output.Plans, err = store.DHFConditionalProposalsForActor(ctx, actor.ID)
	if err != nil {
		return output, err
	}
	alreadyFiled := map[string]bool{}
	for _, plan := range output.Plans {
		alreadyFiled[plan.ProjectID+"|"+plan.StageID+"|"+plan.DependencyID] = true
	}
	remaining := make([]ports.DHFConditionalPlanOption, 0, len(output.Options))
	for _, option := range output.Options {
		if !alreadyFiled[option.ProjectID+"|"+option.StageID+"|"+option.DependencyID] {
			remaining = append(remaining, option)
		}
	}
	output.Options = remaining
	return output, err
}
func dhfConditionalReauth(ctx context.Context, tx ports.Tx,
	store ports.DHFConditionalProposalStore, actor domain.User, password, sourceID string) (bool, error) {
	if len(password) == 0 || len(password) > 1024 {
		return false, nil
	}
	trusted, err := tx.UserByID(ctx, actor.ID)
	if err != nil || trusted.ID != actor.ID || trusted.DisabledAt != nil ||
		trusted.MustChangePassword || trusted.Login == "" ||
		(actor.Login != "" && actor.Login != trusted.Login) {
		return false, nil
	}
	attempts, err := store.DHFPilotRecentAttestationAuthFailures(ctx, actor.ID)
	if err != nil {
		return false, err
	}
	if attempts >= 5 {
		return false, nil
	}
	current, hash, err := tx.UserByLogin(ctx, trusted.Login)
	if err != nil || current.ID != actor.ID ||
		bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		if err = store.DHFPilotAuditAttestationAuthFailure(ctx, actor.ID, sourceID); err != nil {
			return false, err
		}
		return false, nil
	}
	return true, nil
}
func (s *Service) DHFConditionalProposalFile(ctx context.Context, actor domain.User, input DHFConditionalProposalInput) (DHFConditionalProposalOutcome, error) {
	fail := func(reason string) DHFConditionalProposalOutcome {
		return DHFConditionalProposalOutcome{Reason: reason, TrialOnly: true}
	}
	if actor.ID == "" || input.ProjectID == "" || input.StageID == "" || input.DependencyID == "" {
		return fail("DHF_SCOPE_DENIED"), nil
	}
	if len(input.IdempotencyKey) < 8 || len(input.IdempotencyKey) > 160 ||
		strings.TrimSpace(input.IdempotencyKey) != input.IdempotencyKey {
		return fail("DHF_IDEMPOTENCY_KEY_INVALID"), nil
	}
	if len(input.Reason) < 10 || len(input.Reason) > 2000 || strings.TrimSpace(input.Reason) != input.Reason {
		return fail("DHF_CONDITION_REASON_INVALID"), nil
	}
	now := time.Now()
	if input.ExpiresAt.Before(now.Add(time.Minute)) || input.ExpiresAt.After(now.Add(30*24*time.Hour)) ||
		len(input.Obligations) < 1 || len(input.Obligations) > 32 {
		return fail("DHF_CONDITION_DEADLINE_INVALID"), nil
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return fail("DHF_CONDITION_UNAVAILABLE"), err
	}
	defer tx.Rollback(ctx)
	store, ok := any(tx).(ports.DHFConditionalProposalStore)
	if !ok {
		return fail("DHF_CONDITION_UNAVAILABLE"), errors.New("conditional store unavailable")
	}
	if err = store.DHFPilotBeginSubmission(ctx); err != nil {
		return fail("DHF_CONDITION_UNAVAILABLE"), err
	}
	policy, err := store.DHFConditionalPolicyForActor(ctx, input.ProjectID, input.StageID, actor.ID)
	if errors.Is(err, ports.ErrRowMissing) {
		return fail("DHF_SCOPE_DENIED"), nil
	}
	if err != nil {
		return fail("DHF_CONDITION_UNAVAILABLE"), err
	}
	options, err := dhfConditionalOption(policy)
	if err != nil {
		return fail("DHF_CONDITION_UNAVAILABLE"), err
	}
	var selected *ports.DHFConditionalPlanOption
	for i := range options {
		if options[i].DependencyID == input.DependencyID {
			selected = &options[i]
			break
		}
	}
	if selected == nil {
		return fail("DHF_CONDITION_NOT_ELIGIBLE"), nil
	}
	permitted := map[string]bool{}
	for _, id := range selected.EligibleRequirements {
		permitted[id] = true
	}
	seen := map[string]bool{}
	for _, item := range input.Obligations {
		if !permitted[item.RequirementID] || seen[item.RequirementID] ||
			item.OwnerID == "" || len(strings.TrimSpace(item.CorrectiveAction)) < 10 ||
			len(item.CorrectiveAction) > 1000 ||
			item.DueAt.Before(now.Add(time.Minute)) || item.DueAt.After(input.ExpiresAt) {
			return fail("DHF_CONDITION_OBLIGATION_INVALID"), nil
		}
		seen[item.RequirementID] = true
	}
	okPass, err := dhfConditionalReauth(ctx, tx, store, actor, input.Password, input.ProjectID)
	if err != nil {
		return fail("DHF_CONDITION_UNAVAILABLE"), err
	}
	if !okPass {
		// The failure event is persisted without any plan. A bad password
		// must never create or modify the original conditional ledger.
		if err = tx.Commit(ctx); err != nil {
			return fail("DHF_CONDITION_UNAVAILABLE"), err
		}
		return fail("DHF_REAUTH_FAILED"), nil
	}
	canonical, _ := json.Marshal(struct {
		ProjectID    string
		StageID      string
		DependencyID string
		Obligations  []ports.DHFConditionalObligation
		Reason       string
		ExpiresAt    time.Time
	}{input.ProjectID, input.StageID, input.DependencyID, input.Obligations, input.Reason, input.ExpiresAt})
	sum := sha256.Sum256([]byte("DHF-PILOT-CONDITIONAL-PROPOSAL-V1\x00" +
		actor.ID + "\x00" + input.IdempotencyKey + "\x00" + string(canonical)))
	requestSHA := hex.EncodeToString(sum[:])
	prev, err := store.DHFConditionalProposalByScope(ctx, input.ProjectID, input.StageID,
		policy.TemplateID, input.DependencyID)
	if err == nil {
		if prev.ProposedBy == actor.ID && prev.IdempotencyKey == input.IdempotencyKey &&
			prev.RequestSHA == requestSHA {
			return DHFConditionalProposalOutcome{ID: prev.ID, Status: prev.Status, Replayed: true, TrialOnly: true}, nil
		}
		return fail("DHF_CONDITION_ALREADY_FILED"), nil
	}
	if !errors.Is(err, ports.ErrRowMissing) {
		return fail("DHF_CONDITION_UNAVAILABLE"), err
	}
	record := ports.DHFConditionalProposal{ID: NewID("dhfcondition"),
		ProjectID: policy.ProjectID, StageID: policy.StageID, TemplateID: policy.TemplateID,
		PolicySHA: policy.PolicySHA, ProposedBy: actor.ID,
		DependencyID: selected.DependencyID, PredecessorStage: selected.PredecessorStage,
		GuardedAction: selected.GuardedAction, Obligations: input.Obligations,
		Reason: input.Reason, ExpiresAt: input.ExpiresAt,
		IdempotencyKey: input.IdempotencyKey, RequestSHA: requestSHA,
		Status: "awaiting_enterprise_authority", TrialOnly: true}
	if err = store.DHFConditionalPersist(ctx, record); err != nil {
		return fail("DHF_CONDITION_PRECONDITION"), err
	}
	if err = tx.Commit(ctx); err != nil {
		return fail("DHF_CONDITION_PRECONDITION"), err
	}
	return DHFConditionalProposalOutcome{ID: record.ID, Status: record.Status, TrialOnly: true}, nil
}
func (s *Service) DHFConditionalProposalWithdraw(ctx context.Context, actor domain.User,
	id string, input DHFConditionalWithdrawalInput) (DHFConditionalProposalOutcome, error) {
	fail := func(reason string) DHFConditionalProposalOutcome {
		return DHFConditionalProposalOutcome{Reason: reason, TrialOnly: true}
	}
	if actor.ID == "" || id == "" {
		return fail("DHF_SCOPE_DENIED"), nil
	}
	if len(input.Reason) < 10 || len(input.Reason) > 1000 ||
		strings.TrimSpace(input.Reason) != input.Reason {
		return fail("DHF_CONDITION_REASON_INVALID"), nil
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return fail("DHF_CONDITION_UNAVAILABLE"), err
	}
	defer tx.Rollback(ctx)
	store, ok := any(tx).(ports.DHFConditionalProposalStore)
	if !ok {
		return fail("DHF_CONDITION_UNAVAILABLE"), errors.New("conditional store unavailable")
	}
	if err = store.DHFPilotBeginSubmission(ctx); err != nil {
		return fail("DHF_CONDITION_UNAVAILABLE"), err
	}
	rec, err := store.DHFConditionalProposalByID(ctx, id, actor.ID)
	if errors.Is(err, ports.ErrRowMissing) {
		return fail("DHF_SCOPE_DENIED"), nil
	}
	if err != nil {
		return fail("DHF_CONDITION_UNAVAILABLE"), err
	}
	valid, err := dhfConditionalReauth(ctx, tx, store, actor, input.Password, rec.ProjectID)
	if err != nil {
		return fail("DHF_CONDITION_UNAVAILABLE"), err
	}
	if !valid {
		if err = tx.Commit(ctx); err != nil {
			return fail("DHF_CONDITION_UNAVAILABLE"), err
		}
		return fail("DHF_REAUTH_FAILED"), nil
	}
	if rec.Status == "withdrawn" {
		if rec.WithdrawalReason == input.Reason {
			return DHFConditionalProposalOutcome{ID: id, Status: "withdrawn", Replayed: true, TrialOnly: true}, nil
		}
		return fail("DHF_CONDITION_WITHDRAW_CONFLICT"), nil
	}
	if err = store.DHFConditionalWithdraw(ctx, ports.DHFConditionalWithdrawal{
		ID: NewID("dhfwithdraw"), ProposalID: id, ActorID: actor.ID, Reason: input.Reason}); err != nil {
		return fail("DHF_CONDITION_WITHDRAW_CONFLICT"), err
	}
	if err = tx.Commit(ctx); err != nil {
		return fail("DHF_CONDITION_UNAVAILABLE"), err
	}
	return DHFConditionalProposalOutcome{ID: id, Status: "withdrawn", TrialOnly: true}, nil
}
