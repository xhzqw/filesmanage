package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

var _ ports.DHFPilotCredentialGovernanceStore = (*Repository)(nil)

func (r *Repository) DHFPilotCredentialOperatorAllowed(ctx context.Context, actorID, signerID string) (bool, error) {
	var allowed bool
	err := r.Q.QueryRow(ctx, `
SELECT EXISTS(SELECT 1
 FROM dhf_pilot_credential_operator_grants g
 JOIN users u ON u.id=g.operator_id AND u.disabled_at IS NULL
  AND NOT u.must_change_password
 JOIN users approver ON approver.id=g.approved_by AND approver.disabled_at IS NULL
 WHERE g.operator_id=$1 AND ($2='' OR (g.approved_by<>$2 AND g.operator_id<>$2))
  AND NOT EXISTS(SELECT 1 FROM dhf_pilot_credential_operator_revocations revoked WHERE revoked.grant_id=g.id)
  AND g.trial_only AND transaction_timestamp()>=g.valid_from
  AND transaction_timestamp()<g.expires_at)`, actorID, signerID).Scan(&allowed)
	return allowed, err
}
func (r *Repository) DHFPilotCredentialSignerEligible(ctx context.Context, signerID string) (bool, error) {
	var ok bool
	err := r.Q.QueryRow(ctx, `
SELECT EXISTS(SELECT 1 FROM dhf_pilot_review_assignments a
 JOIN dhf_pilot_projects p ON p.id=a.project_id AND p.state='active'
 JOIN dhf_pilot_members m ON m.project_id=a.project_id AND m.user_id=a.reviewer_id
 JOIN users u ON u.id=a.reviewer_id AND u.disabled_at IS NULL
  AND NOT u.must_change_password
 WHERE a.reviewer_id=$1 AND a.review_key='__gate__'
 AND a.stage_id IN ('G5','G6'))`, signerID).Scan(&ok)
	return ok, err
}

const credentialListColumns = `c.id,c.signer_id,c.key_sha,c.valid_from,c.expires_at,
c.registered_by,c.authorization_ref,COALESCE(latest.event_kind,'unactivated'),
COALESCE(c.idempotency_key,''),COALESCE(c.request_sha,'')`
const credentialListJoins = `
FROM dhf_pilot_signing_credentials c
LEFT JOIN LATERAL (
 SELECT event_kind FROM dhf_pilot_signing_credential_events e
 WHERE e.credential_id=c.id ORDER BY e.event_seq DESC LIMIT 1
) latest ON true`

func scanCredential(rows pgx.Rows) ([]ports.DHFPilotCredentialItem, error) {
	result := make([]ports.DHFPilotCredentialItem, 0)
	for rows.Next() {
		var x ports.DHFPilotCredentialItem
		if err := rows.Scan(&x.ID, &x.SignerID, &x.KeySHA, &x.ValidFrom, &x.ExpiresAt,
			&x.RegisteredBy, &x.AuthorizationRef, &x.Status, &x.IdempotencyKey, &x.RequestSHA); err != nil {
			return nil, err
		}
		x.TrialOnly = true
		result = append(result, x)
	}
	return result, rows.Err()
}
func (r *Repository) DHFPilotCredentialsForOperator(ctx context.Context, actor string, limit int) ([]ports.DHFPilotCredentialItem, error) {
	if limit < 1 || limit > 100 {
		limit = 50
	}
	rows, err := r.Q.Query(ctx, `SELECT `+credentialListColumns+credentialListJoins+`
 WHERE c.registered_by=$1 ORDER BY c.registered_at DESC,c.id LIMIT $2`, actor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanCredential(rows)
}
func (r *Repository) DHFPilotCredentialByID(ctx context.Context, id string) (ports.DHFPilotCredentialItem, error) {
	var x ports.DHFPilotCredentialItem
	rows, err := r.Q.Query(ctx, `SELECT `+credentialListColumns+credentialListJoins+`
 WHERE c.id=$1 FOR UPDATE OF c`, id)
	if err != nil {
		return x, err
	}
	defer rows.Close()
	items, err := scanCredential(rows)
	if err != nil {
		return x, err
	}
	if len(items) == 0 {
		return x, ports.ErrRowMissing
	}
	return items[0], nil
}
func (r *Repository) DHFPilotCredentialRegistrationByKey(ctx context.Context, actor, key string) (ports.DHFPilotCredentialItem, error) {
	var x ports.DHFPilotCredentialItem
	rows, err := r.Q.Query(ctx, `SELECT `+credentialListColumns+credentialListJoins+`
 WHERE c.registered_by=$1 AND c.idempotency_key=$2`, actor, key)
	if err != nil {
		return x, err
	}
	defer rows.Close()
	items, err := scanCredential(rows)
	if err != nil {
		return x, err
	}
	if len(items) == 0 {
		return x, ports.ErrRowMissing
	}
	return items[0], nil
}
func (r *Repository) DHFPilotCredentialEventByKey(ctx context.Context, actor, key string) (ports.DHFPilotCredentialEvent, error) {
	var x ports.DHFPilotCredentialEvent
	err := r.Q.QueryRow(ctx, `SELECT id,credential_id,actor_id,event_kind,reason,
 COALESCE(idempotency_key,''),COALESCE(request_sha,'')
 FROM dhf_pilot_signing_credential_events WHERE actor_id=$1 AND idempotency_key=$2`, actor, key).
		Scan(&x.ID, &x.CredentialID, &x.ActorID, &x.Kind, &x.Reason, &x.IdempotencyKey, &x.RequestSHA)
	if errors.Is(err, pgx.ErrNoRows) {
		return x, ports.ErrRowMissing
	}
	return x, err
}
func (r *Repository) DHFPilotRegisterCredential(ctx context.Context, x ports.DHFPilotCredentialItem, key, sha string) error {
	// The public verifier is derived ONLY from the externally pinned key and
	// the service's explicit equality check; never from untrusted signer input.
	_, err := r.Q.Exec(ctx, `INSERT INTO dhf_pilot_signing_credentials(
 id,signer_id,public_key_ed25519,purpose,valid_from,expires_at,registered_by,
 authorization_ref,idempotency_key,request_sha)
 VALUES($1,$2,decode($3,'base64'),'dhf.pilot.gate.candidate',$4,$5,$6,$7,$8,$9)`,
		x.ID, x.SignerID, key, x.ValidFrom, x.ExpiresAt, x.RegisteredBy, x.AuthorizationRef, x.IdempotencyKey, sha)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO audit_events(actor_id,event_type,target_kind,target_id,request_id,outcome,details)
 VALUES($1,'dhf.pilot.credential.register','dhf_signing_credential',$2,$3,'trial_only',
 jsonb_build_object('keySha',$4::text,'authorizationRef',$5::text,'signerId',$6::text))`,
		x.RegisteredBy, x.ID, x.IdempotencyKey, x.KeySHA, x.AuthorizationRef, x.SignerID)
	return err
}
func (r *Repository) DHFPilotAppendCredentialEvent(ctx context.Context, x ports.DHFPilotCredentialEvent, key, sha string) error {
	_, err := r.Q.Exec(ctx, `INSERT INTO dhf_pilot_signing_credential_events(
 id,credential_id,actor_id,event_kind,reason,idempotency_key,request_sha)
 VALUES($1,$2,$3,$4,$5,$6,$7)`,
		x.ID, x.CredentialID, x.ActorID, x.Kind, x.Reason, x.IdempotencyKey, sha)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO audit_events(actor_id,event_type,target_kind,target_id,request_id,outcome,details)
 VALUES($1,'dhf.pilot.credential.'||$2,'dhf_signing_credential',$3,$4,'trial_only',
 jsonb_build_object('eventId',$5::text,'reason',$6::text))`,
		x.ActorID, x.Kind, x.CredentialID, x.IdempotencyKey, x.ID, x.Reason)
	return err
}
func (r *Repository) DHFPilotAuditCredentialAuthFailure(ctx context.Context, actorID, resourceID string) error {
	_, err := r.Q.Exec(ctx, `INSERT INTO audit_events(actor_id,event_type,target_kind,target_id,request_id,outcome,details)
 VALUES($1,'dhf.pilot.credential_auth_denied','dhf_signing_credential',$2,$3,'denied',
 jsonb_build_object('authentication','password_reauthentication','reason','invalid_credential'))`,
		actorID, resourceID, newID("dhfcredauth"))
	return err
}
