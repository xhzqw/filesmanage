package application

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type DHFPilotCredentialPage struct {
	Items     []ports.DHFPilotCredentialItem `json:"items"`
	CanManage bool                           `json:"canManage"`
	TrialOnly bool                           `json:"trialOnly"`
}
type DHFPilotCredentialMutation struct {
	ID           string `json:"id,omitempty"`
	CredentialID string `json:"credentialId,omitempty"`
	Replayed     bool   `json:"replayed"`
	TrialOnly    bool   `json:"trialOnly"`
	Reason       string `json:"reason,omitempty"`
}
type DHFPilotRegisterCredentialRequest struct {
	SignerID         string    `json:"signerId"`
	PublicKeyBase64  string    `json:"publicKeyBase64"`
	ValidFrom        time.Time `json:"validFrom"`
	ExpiresAt        time.Time `json:"expiresAt"`
	AuthorizationRef string    `json:"authorizationRef"`
	Password         string    `json:"password"`
	IdempotencyKey   string    `json:"idempotencyKey"`
}
type DHFPilotCredentialActionRequest struct {
	Kind           string `json:"kind"`
	Reason         string `json:"reason"`
	Password       string `json:"password"`
	IdempotencyKey string `json:"idempotencyKey"`
}

func validPilotCredentialKey(key string) bool {
	return len(key) >= 8 && len(key) <= 160 && strings.TrimSpace(key) == key
}
func credentialRequestHash(v any) string { data, _ := json.Marshal(v); return dhfGateDigest(data) }

func (s *Service) DHFPilotCredentialList(ctx context.Context, actor domain.User) (DHFPilotCredentialPage, error) {
	out := DHFPilotCredentialPage{Items: []ports.DHFPilotCredentialItem{}, TrialOnly: true}
	if actor.ID == "" {
		return out, ErrUnauthorized
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	store, ok := any(tx).(ports.DHFPilotCredentialGovernanceStore)
	if !ok {
		return out, errors.New("DHF credential governance unavailable")
	}
	if err = store.DHFPilotBeginSnapshot(ctx); err != nil {
		return out, err
	}
	trusted, err := tx.UserByID(ctx, actor.ID)
	if err != nil || trusted.ID != actor.ID || trusted.DisabledAt != nil || trusted.MustChangePassword {
		return out, ErrUnauthorized
	}
	out.CanManage, err = store.DHFPilotCredentialOperatorAllowed(ctx, actor.ID, "")
	if err != nil {
		return out, err
	}
	if !out.CanManage {
		return out, nil
	}
	out.Items, err = store.DHFPilotCredentialsForOperator(ctx, actor.ID, 100)
	return out, err
}

// Operator reauthentication is required even for idempotent retries.
// All failed reauth attempts share the existing 15-minute limit with reviews.
func (s *Service) dhfCredentialReauth(ctx context.Context, tx ports.Repository, store ports.DHFPilotCredentialGovernanceStore, actor domain.User, password, target string) (string, error) {
	trusted, err := tx.UserByID(ctx, actor.ID)
	if err != nil || trusted.ID != actor.ID || trusted.DisabledAt != nil ||
		trusted.MustChangePassword || trusted.Login == "" || trusted.Login != actor.Login {
		return "DHF_SCOPE_DENIED", nil
	}
	auditStore, ok := any(tx).(ports.DHFPilotAttestationStore)
	if !ok {
		return "", errors.New("DHF reauthentication audit store missing")
	}
	attempts, err := auditStore.DHFPilotRecentAttestationAuthFailures(ctx, actor.ID)
	if err != nil {
		return "", err
	}
	if attempts >= 5 {
		return "DHF_REAUTH_RATE_LIMITED", nil
	}
	current, hash, err := tx.UserByLogin(ctx, trusted.Login)
	if err != nil || current.ID != actor.ID || current.MustChangePassword ||
		bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		if err = store.DHFPilotAuditCredentialAuthFailure(ctx, actor.ID, target); err != nil {
			return "", err
		}
		if err = tx.Commit(ctx); err != nil {
			return "", err
		}
		return "DHF_REAUTH_FAILED", nil
	}
	return "", nil
}

func (s *Service) DHFPilotRegisterCredential(ctx context.Context, actor domain.User, req DHFPilotRegisterCredentialRequest) (DHFPilotCredentialMutation, error) {
	fail := func(reason string) DHFPilotCredentialMutation {
		return DHFPilotCredentialMutation{TrialOnly: true, Reason: reason}
	}
	if actor.ID == "" || req.SignerID == "" || req.SignerID == actor.ID {
		return fail("DHF_SCOPE_DENIED"), nil
	}
	if !validPilotCredentialKey(req.IdempotencyKey) {
		return fail("DHF_IDEMPOTENCY_KEY_INVALID"), nil
	}
	if len(req.Password) < 1 || len(req.Password) > 1024 {
		return fail("DHF_REAUTH_FAILED"), nil
	}
	if len(strings.TrimSpace(req.AuthorizationRef)) < 8 || len(req.AuthorizationRef) > 512 ||
		req.ValidFrom.IsZero() || req.ExpiresAt.IsZero() || !req.ValidFrom.Before(req.ExpiresAt) ||
		req.ExpiresAt.Sub(req.ValidFrom) > 30*24*time.Hour {
		return fail("DHF_CREDENTIAL_INVALID"), nil
	}
	publicKey, keySHA, ok := dhfTrustedGateKey()
	supplied, decodeErr := base64.StdEncoding.DecodeString(req.PublicKeyBase64)
	if !ok {
		return fail("DHF_GATE_TRUST_POLICY_MISSING"), nil
	}
	if decodeErr != nil || len(supplied) != ed25519.PublicKeySize ||
		!stringEqualBytes(publicKey, supplied) {
		return fail("DHF_CREDENTIAL_KEY_UNTRUSTED"), nil
	}
	requestSHA := credentialRequestHash(struct {
		Domain, Actor, Signer, KeySHA, AuthorizationRef, From, Until string
	}{"DHF-CREDENTIAL-REGISTER-V1", actor.ID, req.SignerID, keySHA,
		strings.TrimSpace(req.AuthorizationRef), req.ValidFrom.UTC().Format(time.RFC3339Nano),
		req.ExpiresAt.UTC().Format(time.RFC3339Nano)})
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return fail("DHF_CREDENTIAL_UNAVAILABLE"), err
	}
	defer tx.Rollback(ctx)
	store, ok := any(tx).(ports.DHFPilotCredentialGovernanceStore)
	if !ok {
		return fail("DHF_CREDENTIAL_UNAVAILABLE"), errors.New("credential store missing")
	}
	if err = store.DHFPilotBeginSubmission(ctx); err != nil {
		return fail("DHF_CREDENTIAL_UNAVAILABLE"), err
	}
	allowed, err := store.DHFPilotCredentialOperatorAllowed(ctx, actor.ID, req.SignerID)
	if err != nil {
		return fail("DHF_CREDENTIAL_UNAVAILABLE"), err
	}
	if !allowed {
		return fail("DHF_CREDENTIAL_OPERATOR_DENIED"), nil
	}
	reason, err := s.dhfCredentialReauth(ctx, tx, store, actor, req.Password, req.SignerID)
	if err != nil {
		return fail("DHF_CREDENTIAL_UNAVAILABLE"), err
	}
	if reason != "" {
		return fail(reason), nil
	}
	previous, err := store.DHFPilotCredentialRegistrationByKey(ctx, actor.ID, req.IdempotencyKey)
	if err == nil {
		if previous.RequestSHA == requestSHA && previous.KeySHA == keySHA {
			return DHFPilotCredentialMutation{ID: previous.ID, CredentialID: previous.ID, Replayed: true, TrialOnly: true}, nil
		}
		return fail("DHF_CREDENTIAL_IDEMPOTENCY_CONFLICT"), nil
	}
	if !errors.Is(err, ports.ErrRowMissing) {
		return fail("DHF_CREDENTIAL_UNAVAILABLE"), err
	}
	eligible, err := store.DHFPilotCredentialSignerEligible(ctx, req.SignerID)
	if err != nil {
		return fail("DHF_CREDENTIAL_UNAVAILABLE"), err
	}
	if !eligible {
		return fail("DHF_CREDENTIAL_SIGNER_INELIGIBLE"), nil
	}
	rec := ports.DHFPilotCredentialItem{ID: NewID("dhfcred"), SignerID: req.SignerID,
		RegisteredBy: actor.ID, KeySHA: keySHA, AuthorizationRef: strings.TrimSpace(req.AuthorizationRef),
		ValidFrom: req.ValidFrom, ExpiresAt: req.ExpiresAt, IdempotencyKey: req.IdempotencyKey,
		RequestSHA: requestSHA, Status: "unactivated", TrialOnly: true}
	if err = store.DHFPilotRegisterCredential(ctx, rec, req.PublicKeyBase64, requestSHA); err != nil {
		return fail("DHF_CREDENTIAL_CONFLICT"), err
	}
	if err = tx.Commit(ctx); err != nil {
		return fail("DHF_CREDENTIAL_CONFLICT"), err
	}
	return DHFPilotCredentialMutation{ID: rec.ID, CredentialID: rec.ID, TrialOnly: true}, nil
}

func stringEqualBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := range a {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}

func (s *Service) DHFPilotCredentialTransition(ctx context.Context, actor domain.User, credentialID string, req DHFPilotCredentialActionRequest) (DHFPilotCredentialMutation, error) {
	fail := func(reason string) DHFPilotCredentialMutation {
		return DHFPilotCredentialMutation{CredentialID: credentialID, TrialOnly: true, Reason: reason}
	}
	if actor.ID == "" || credentialID == "" {
		return fail("DHF_SCOPE_DENIED"), nil
	}
	if !validPilotCredentialKey(req.IdempotencyKey) {
		return fail("DHF_IDEMPOTENCY_KEY_INVALID"), nil
	}
	if len(req.Password) < 1 || len(req.Password) > 1024 {
		return fail("DHF_REAUTH_FAILED"), nil
	}
	if req.Kind != "activate" && req.Kind != "suspend" && req.Kind != "revoke" && req.Kind != "replace" ||
		len(strings.TrimSpace(req.Reason)) < 8 || len(req.Reason) > 1000 {
		return fail("DHF_CREDENTIAL_EVENT_INVALID"), nil
	}
	requestSHA := credentialRequestHash(struct{ Domain, Actor, CredentialID, Kind, Reason string }{
		"DHF-CREDENTIAL-EVENT-V1", actor.ID, credentialID, req.Kind, strings.TrimSpace(req.Reason)})
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return fail("DHF_CREDENTIAL_UNAVAILABLE"), err
	}
	defer tx.Rollback(ctx)
	store, ok := any(tx).(ports.DHFPilotCredentialGovernanceStore)
	if !ok {
		return fail("DHF_CREDENTIAL_UNAVAILABLE"), errors.New("credential store missing")
	}
	if err = store.DHFPilotBeginSubmission(ctx); err != nil {
		return fail("DHF_CREDENTIAL_UNAVAILABLE"), err
	}
	allowed, err := store.DHFPilotCredentialOperatorAllowed(ctx, actor.ID, "")
	if err != nil {
		return fail("DHF_CREDENTIAL_UNAVAILABLE"), err
	}
	if !allowed {
		return fail("DHF_CREDENTIAL_OPERATOR_DENIED"), nil
	}
	reason, err := s.dhfCredentialReauth(ctx, tx, store, actor, req.Password, credentialID)
	if err != nil {
		return fail("DHF_CREDENTIAL_UNAVAILABLE"), err
	}
	if reason != "" {
		return fail(reason), nil
	}
	previous, err := store.DHFPilotCredentialEventByKey(ctx, actor.ID, req.IdempotencyKey)
	if err == nil {
		if previous.RequestSHA == requestSHA && previous.CredentialID == credentialID && previous.Kind == req.Kind {
			return DHFPilotCredentialMutation{ID: previous.ID, CredentialID: credentialID, Replayed: true, TrialOnly: true}, nil
		}
		return fail("DHF_CREDENTIAL_IDEMPOTENCY_CONFLICT"), nil
	}
	if !errors.Is(err, ports.ErrRowMissing) {
		return fail("DHF_CREDENTIAL_UNAVAILABLE"), err
	}
	subject, err := store.DHFPilotCredentialByID(ctx, credentialID)
	if errors.Is(err, ports.ErrRowMissing) {
		return fail("DHF_SCOPE_DENIED"), nil
	}
	if err != nil {
		return fail("DHF_CREDENTIAL_UNAVAILABLE"), err
	}
	allowed, err = store.DHFPilotCredentialOperatorAllowed(ctx, actor.ID, subject.SignerID)
	if err != nil {
		return fail("DHF_CREDENTIAL_UNAVAILABLE"), err
	}
	if !allowed {
		return fail("DHF_CREDENTIAL_OPERATOR_DENIED"), nil
	}
	status := subject.Status
	if !((status == "unactivated" && req.Kind == "activate") ||
		(status == "activate" && (req.Kind == "suspend" || req.Kind == "revoke" || req.Kind == "replace")) ||
		(status == "suspend" && (req.Kind == "activate" || req.Kind == "revoke" || req.Kind == "replace"))) {
		return fail("DHF_CREDENTIAL_TRANSITION_INVALID"), nil
	}
	if req.Kind == "activate" && (time.Now().Before(subject.ValidFrom) || !time.Now().Before(subject.ExpiresAt)) {
		return fail("DHF_CREDENTIAL_OUTSIDE_VALIDITY"), nil
	}
	row := ports.DHFPilotCredentialEvent{ID: NewID("dhfcredevent"), CredentialID: credentialID,
		ActorID: actor.ID, Kind: req.Kind, Reason: strings.TrimSpace(req.Reason),
		IdempotencyKey: req.IdempotencyKey, RequestSHA: requestSHA}
	if err = store.DHFPilotAppendCredentialEvent(ctx, row, req.IdempotencyKey, requestSHA); err != nil {
		return fail("DHF_CREDENTIAL_CONFLICT"), err
	}
	if err = tx.Commit(ctx); err != nil {
		return fail("DHF_CREDENTIAL_CONFLICT"), err
	}
	return DHFPilotCredentialMutation{ID: row.ID, CredentialID: credentialID, TrialOnly: true}, nil
}
