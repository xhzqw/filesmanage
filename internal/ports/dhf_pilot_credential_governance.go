package ports

import (
	"context"
	"time"
)

// Trial-only issuance/custody. No actor gains this role from is_admin;
// only separate, time-bounded database grants authorize operations.
type DHFPilotCredentialGovernanceStore interface {
	DHFPilotBeginSubmission(context.Context) error
	DHFPilotBeginSnapshot(context.Context) error
	DHFPilotCredentialOperatorAllowed(context.Context, string, string) (bool, error)
	DHFPilotCredentialSignerEligible(context.Context, string) (bool, error)
	DHFPilotCredentialsForOperator(context.Context, string, int) ([]DHFPilotCredentialItem, error)
	DHFPilotCredentialByID(context.Context, string) (DHFPilotCredentialItem, error)
	DHFPilotCredentialRegistrationByKey(context.Context, string, string) (DHFPilotCredentialItem, error)
	DHFPilotCredentialEventByKey(context.Context, string, string) (DHFPilotCredentialEvent, error)
	DHFPilotRegisterCredential(context.Context, DHFPilotCredentialItem, string, string) error
	DHFPilotAppendCredentialEvent(context.Context, DHFPilotCredentialEvent, string, string) error
	DHFPilotAuditCredentialAuthFailure(context.Context, string, string) error
}

type DHFPilotCredentialItem struct {
	ID               string    `json:"id"`
	SignerID         string    `json:"signerId"`
	KeySHA           string    `json:"keySha"`
	Status           string    `json:"status"`
	ValidFrom        time.Time `json:"validFrom"`
	ExpiresAt        time.Time `json:"expiresAt"`
	RegisteredBy     string    `json:"registeredBy"`
	AuthorizationRef string    `json:"authorizationRef"`
	IdempotencyKey   string    `json:"-"`
	RequestSHA       string    `json:"-"`
	TrialOnly        bool      `json:"trialOnly"`
}
type DHFPilotCredentialEvent struct {
	ID             string `json:"id"`
	CredentialID   string `json:"credentialId"`
	ActorID        string `json:"actorId"`
	Kind           string `json:"kind"`
	Reason         string `json:"reason"`
	IdempotencyKey string `json:"-"`
	RequestSHA     string `json:"-"`
}
