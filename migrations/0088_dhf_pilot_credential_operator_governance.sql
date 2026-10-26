-- Trial signer-credential custody: application admin is NOT an issuer role.
-- Delegation is out-of-band and must have a distinct approving person.
-- No browser/API endpoint can create an operator grant.
CREATE TABLE dhf_pilot_credential_operator_grants (
 id text PRIMARY KEY,
 operator_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 approved_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 authorization_ref text NOT NULL CHECK(length(btrim(authorization_ref)) BETWEEN 8 AND 512),
 valid_from timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 trial_only boolean NOT NULL DEFAULT true CHECK(trial_only),
 granted_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CHECK(operator_id<>approved_by),
 CHECK(valid_from<expires_at),
 CHECK(expires_at-valid_from<=interval '30 days')
);
CREATE INDEX ix_dhf_credential_operator_grant_actor
 ON dhf_pilot_credential_operator_grants(operator_id,expires_at);
CREATE TRIGGER dhf_pilot_credential_operator_grants_immutable
 BEFORE UPDATE OR DELETE ON dhf_pilot_credential_operator_grants
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();

CREATE FUNCTION dhf_pilot_operator_grant_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM audit_events a
  WHERE a.actor_id=NEW.approved_by AND a.event_type='dhf.pilot.credential.operator_granted'
    AND a.target_kind='dhf_credential_operator' AND a.target_id=NEW.id
    AND a.details->>'operatorId'=NEW.operator_id
    AND a.details->>'authorizationRef'=NEW.authorization_ref
 ) THEN RAISE EXCEPTION 'credential operator grant requires independent audit'
   USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER dhf_pilot_operator_grant_audit_required
 AFTER INSERT ON dhf_pilot_credential_operator_grants
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_operator_grant_audit();

-- Emergency removal of delegated issuance authority remains possible
-- without rewriting history or waiting up to 30 days for grant expiration.
CREATE TABLE dhf_pilot_credential_operator_revocations(
 id text PRIMARY KEY,
 grant_id text NOT NULL UNIQUE REFERENCES dhf_pilot_credential_operator_grants(id) ON DELETE RESTRICT,
 revoked_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 8 AND 1000),
 revoked_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
CREATE TRIGGER dhf_pilot_credential_operator_revocations_immutable
 BEFORE UPDATE OR DELETE ON dhf_pilot_credential_operator_revocations
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();
CREATE FUNCTION dhf_pilot_operator_revoke_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE operator text;
DECLARE approver text;
BEGIN
 SELECT operator_id,approved_by INTO operator,approver FROM dhf_pilot_credential_operator_grants
  WHERE id=NEW.grant_id FOR UPDATE;
 IF operator IS NULL OR NEW.revoked_by=operator OR NEW.revoked_by<>approver THEN
  RAISE EXCEPTION 'only the original independent grant approver may revoke delegation'
   USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER dhf_pilot_credential_operator_revoke_guard
 BEFORE INSERT ON dhf_pilot_credential_operator_revocations
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_operator_revoke_validate();
CREATE FUNCTION dhf_pilot_operator_revoke_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_events a
   WHERE a.actor_id=NEW.revoked_by
    AND a.event_type='dhf.pilot.credential.operator_revoked'
    AND a.target_kind='dhf_credential_operator' AND a.target_id=NEW.grant_id
    AND a.details->>'revokeId'=NEW.id) THEN
  RAISE EXCEPTION 'trial operator revocation requires audit'
   USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER dhf_pilot_credential_operator_revoke_audit_required
 AFTER INSERT ON dhf_pilot_credential_operator_revocations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_operator_revoke_audit();

-- Operator may not manage their own signing credential, or a credential
-- registered without an active bounded, independently approved delegation.
CREATE FUNCTION dhf_pilot_require_trial_credential_operator()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE operator text;
DECLARE signer text;
BEGIN
 IF TG_TABLE_NAME='dhf_pilot_signing_credentials' THEN
   operator:=NEW.registered_by; signer:=NEW.signer_id;
 ELSE
   operator:=NEW.actor_id;
   SELECT c.signer_id INTO signer FROM dhf_pilot_signing_credentials c
    WHERE c.id=NEW.credential_id FOR SHARE;
 END IF;
 IF signer IS NULL OR operator=signer OR NOT EXISTS (
   SELECT 1 FROM dhf_pilot_credential_operator_grants g
   JOIN users staff ON staff.id=g.operator_id
   JOIN users approver ON approver.id=g.approved_by
   WHERE g.operator_id=operator AND g.approved_by<>signer
     AND g.trial_only AND staff.disabled_at IS NULL
     AND approver.disabled_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM dhf_pilot_credential_operator_revocations revoked
      WHERE revoked.grant_id=g.id)
     AND transaction_timestamp()>=g.valid_from
     AND transaction_timestamp()<g.expires_at
 ) THEN RAISE EXCEPTION 'trial credential operator lacks independent live delegation'
    USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER dhf_pilot_credential_issuer_grant_required
 BEFORE INSERT ON dhf_pilot_signing_credentials FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_require_trial_credential_operator();
CREATE TRIGGER dhf_pilot_credential_event_operator_grant_required
 BEFORE INSERT ON dhf_pilot_signing_credential_events FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_require_trial_credential_operator();

-- Nullable for pre-existing rows from 0055; all API-issued rows use these
-- immutable request identities for exact-retry, not last-write-wins updates.
ALTER TABLE dhf_pilot_signing_credentials
 ADD COLUMN idempotency_key text,
 ADD COLUMN request_sha char(64);
ALTER TABLE dhf_pilot_signing_credentials
 ADD CONSTRAINT dhf_pilot_credential_request_pair CHECK
 ((idempotency_key IS NULL)=(request_sha IS NULL));
-- Legacy 0055 rows are preserved, but every newly registered verifier must
-- respect the trial maximum lifetime regardless of the calling API.
ALTER TABLE dhf_pilot_signing_credentials
 ADD CONSTRAINT dhf_pilot_credential_trial_lifetime
 CHECK(expires_at-valid_from<=interval '30 days') NOT VALID;
CREATE UNIQUE INDEX ux_dhf_credential_operator_idempotency
 ON dhf_pilot_signing_credentials(registered_by,idempotency_key)
 WHERE idempotency_key IS NOT NULL;

ALTER TABLE dhf_pilot_signing_credential_events
 ADD COLUMN idempotency_key text,
 ADD COLUMN request_sha char(64);
ALTER TABLE dhf_pilot_signing_credential_events
 ADD CONSTRAINT dhf_pilot_credential_event_request_pair CHECK
 ((idempotency_key IS NULL)=(request_sha IS NULL));
CREATE UNIQUE INDEX ux_dhf_credential_event_idempotency
 ON dhf_pilot_signing_credential_events(actor_id,idempotency_key)
 WHERE idempotency_key IS NOT NULL;
