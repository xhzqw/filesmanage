package ports

import (
	"context"
	"time"
)

// Corporate conditional authorization is intentionally NOT in this port.
type DHFConditionalProposalStore interface {
	DHFPilotBeginSubmission(context.Context) error
	DHFConditionalPoliciesForActor(context.Context, string) ([]DHFConditionalPolicySource, error)
	DHFConditionalPolicyForActor(context.Context, string, string, string) (DHFConditionalPolicySource, error)
	DHFConditionalProposalByScope(context.Context, string, string, string, string) (DHFConditionalProposal, error)
	DHFConditionalProposalsForActor(context.Context, string) ([]DHFConditionalProposal, error)
	DHFConditionalProposalByID(context.Context, string, string) (DHFConditionalProposal, error)
	DHFConditionalPersist(context.Context, DHFConditionalProposal) error
	DHFConditionalWithdraw(context.Context, DHFConditionalWithdrawal) error
	DHFPilotRecentAttestationAuthFailures(context.Context, string) (int, error)
	DHFPilotAuditAttestationAuthFailure(context.Context, string, string) error
}

type DHFConditionalPolicySource struct {
	ProjectID  string
	StageID    string
	TemplateID string
	PolicySHA  string
	PolicyBody []byte
	Graph      []DHFStageGateGraphNode
	Owners     []DHFConditionalOwner
}
type DHFConditionalOwner struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}
type DHFConditionalObligation struct {
	RequirementID    string    `json:"requirementId"`
	OwnerID          string    `json:"ownerId"`
	CorrectiveAction string    `json:"correctiveAction"`
	DueAt            time.Time `json:"dueAt"`
}
type DHFConditionalPlanOption struct {
	ProjectID            string                `json:"projectId"`
	StageID              string                `json:"stageId"`
	TemplateID           string                `json:"templateId"`
	DependencyID         string                `json:"dependencyId"`
	PredecessorStage     string                `json:"predecessorStage"`
	GuardedAction        string                `json:"guardedAction"`
	EligibleRequirements []string              `json:"eligibleRequirements"`
	EligibleOwners       []DHFConditionalOwner `json:"eligibleOwners"`
}
type DHFConditionalProposal struct {
	ID               string                     `json:"id"`
	ProjectID        string                     `json:"projectId"`
	StageID          string                     `json:"stageId"`
	TemplateID       string                     `json:"templateId"`
	PolicySHA        string                     `json:"policySha"`
	ProposedBy       string                     `json:"proposedBy"`
	DependencyID     string                     `json:"dependencyId"`
	PredecessorStage string                     `json:"predecessorStage"`
	GuardedAction    string                     `json:"guardedAction"`
	GraphSHA         string                     `json:"graphSha"`
	Obligations      []DHFConditionalObligation `json:"obligations"`
	Reason           string                     `json:"reason"`
	ExpiresAt        time.Time                  `json:"expiresAt"`
	IdempotencyKey   string                     `json:"-"`
	RequestSHA       string                     `json:"-"`
	Status           string                     `json:"status"`
	WithdrawalReason string                     `json:"withdrawalReason,omitempty"`
	TrialOnly        bool                       `json:"trialOnly"`
	FormalAccepted   bool                       `json:"formalAccepted"`
}
type DHFConditionalWithdrawal struct {
	ID         string
	ProposalID string
	ActorID    string
	Reason     string
}
