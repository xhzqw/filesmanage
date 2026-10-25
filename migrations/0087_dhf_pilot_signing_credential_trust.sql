-- V0.7.5 trial-only Ed25519 signer/credential trust. No enterprise SOP/CA/TSA
-- approval, qualified e-signature, or formal accepted Stage Gate is implied.
CREATE TABLE dhf_pilot_signing_credentials(
 id text PRIMARY KEY,
 signer_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 public_key_ed25519 bytea NOT NULL CHECK(octet_length(public_key_ed25519)=32),
 key_sha char(64) GENERATED ALWAYS AS (encode(sha256(public_key_ed25519),'hex')) STORED,
 purpose text NOT NULL CHECK(purpose='dhf.pilot.gate.candidate'),
 valid_from timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 registered_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 authorization_ref text NOT NULL CHECK(length(btrim(authorization_ref)) BETWEEN 8 AND 512),
 trial_only boolean NOT NULL DEFAULT true CHECK(trial_only),
 registered_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(key_sha), CHECK(valid_from<expires_at), CHECK(registered_by<>signer_id)
);
CREATE INDEX ix_dhf_signing_credentials_signer
 ON dhf_pilot_signing_credentials(signer_id,purpose,expires_at);
CREATE TRIGGER dhf_pilot_signing_credentials_immutable BEFORE UPDATE OR DELETE
 ON dhf_pilot_signing_credentials FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();
CREATE FUNCTION dhf_pilot_signing_credential_register_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.actor_id=NEW.registered_by
  AND a.event_type='dhf.pilot.credential.register'
  AND a.target_kind='dhf_signing_credential' AND a.target_id=NEW.id
  AND a.details->>'keySha'=NEW.key_sha
  AND a.details->>'authorizationRef'=NEW.authorization_ref) THEN
   RAISE EXCEPTION 'trial credential registration requires atomic audit'
    USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER dhf_pilot_signing_credential_register_audit_required
 AFTER INSERT ON dhf_pilot_signing_credentials DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_signing_credential_register_audit();

-- Append-only state transitions; terminal revocation/replacement cannot reopen.
CREATE TABLE dhf_pilot_signing_credential_events(
 event_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 id text NOT NULL UNIQUE,
 credential_id text NOT NULL REFERENCES dhf_pilot_signing_credentials(id) ON DELETE RESTRICT,
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 event_kind text NOT NULL CHECK(event_kind IN('activate','suspend','revoke','replace')),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 8 AND 1000),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
CREATE INDEX ix_dhf_signing_credential_events_latest
 ON dhf_pilot_signing_credential_events(credential_id,event_seq DESC);
CREATE TRIGGER dhf_pilot_signing_credential_events_immutable BEFORE UPDATE OR DELETE
 ON dhf_pilot_signing_credential_events FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();
CREATE FUNCTION dhf_pilot_validate_signing_credential_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_kind text;
DECLARE subject_id text;
BEGIN
 SELECT signer_id INTO subject_id FROM dhf_pilot_signing_credentials
 WHERE id=NEW.credential_id FOR UPDATE;
 IF subject_id IS NULL OR subject_id=NEW.actor_id THEN
  RAISE EXCEPTION 'credential lifecycle actor must be separate from signer'
   USING ERRCODE='23514';
 END IF;
 SELECT event_kind INTO previous_kind FROM dhf_pilot_signing_credential_events
 WHERE credential_id=NEW.credential_id ORDER BY event_seq DESC LIMIT 1;
 IF (previous_kind IS NULL AND NEW.event_kind<>'activate')
 OR (previous_kind='activate' AND NEW.event_kind='activate')
 OR (previous_kind='suspend' AND NEW.event_kind NOT IN('activate','revoke','replace'))
 OR previous_kind IN('revoke','replace') THEN
  RAISE EXCEPTION 'invalid/terminal trial credential state transition' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER dhf_pilot_credential_event_validate BEFORE INSERT
 ON dhf_pilot_signing_credential_events FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_validate_signing_credential_event();

CREATE FUNCTION dhf_pilot_credential_event_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.actor_id=NEW.actor_id
  AND a.event_type='dhf.pilot.credential.'||NEW.event_kind
  AND a.target_kind='dhf_signing_credential' AND a.target_id=NEW.credential_id
  AND a.details->>'eventId'=NEW.id) THEN
  RAISE EXCEPTION 'credential lifecycle event requires same-transaction audit'
   USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER dhf_pilot_credential_event_audit_required
 AFTER INSERT ON dhf_pilot_signing_credential_events DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_credential_event_audit();

-- Preserve legacy historical rows; every new candidate must bind a credential.
ALTER TABLE dhf_pilot_gate_candidates ADD COLUMN signing_credential_id text
 REFERENCES dhf_pilot_signing_credentials(id) ON DELETE RESTRICT;
CREATE INDEX ix_dhf_gate_candidate_credential ON dhf_pilot_gate_candidates(signing_credential_id)
 WHERE signing_credential_id IS NOT NULL;
CREATE FUNCTION dhf_pilot_check_gate_candidate_credential()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed boolean;
BEGIN
 SELECT(c.signer_id=NEW.signer_id AND c.purpose='dhf.pilot.gate.candidate'
  AND c.public_key_ed25519=NEW.trusted_public_key_ed25519
  AND c.key_sha=NEW.trusted_key_sha AND c.trial_only
  AND transaction_timestamp()>=c.valid_from AND transaction_timestamp()<c.expires_at
  AND (SELECT e.event_kind FROM dhf_pilot_signing_credential_events e
   WHERE e.credential_id=c.id ORDER BY e.event_seq DESC LIMIT 1)='activate')
 INTO allowed FROM dhf_pilot_signing_credentials c WHERE c.id=NEW.signing_credential_id
 FOR SHARE OF c;
 IF allowed IS DISTINCT FROM TRUE THEN
  RAISE EXCEPTION 'trial signing credential inactive or not bound to Gate signer'
   USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER dhf_pilot_gate_candidate_credential_identity
 BEFORE INSERT ON dhf_pilot_gate_candidates FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_check_gate_candidate_credential();
CREATE FUNCTION dhf_pilot_gate_candidate_credential_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_events a
   WHERE a.event_type='dhf.pilot.gate.candidate' AND a.target_id=NEW.id
   AND a.details->>'credentialId'=NEW.signing_credential_id)
 OR NOT EXISTS(SELECT 1 FROM outbox_jobs o
   WHERE o.id='dhf-gate-candidate:'||NEW.id
   AND o.payload->>'credentialId'=NEW.signing_credential_id) THEN
  RAISE EXCEPTION 'candidate audit/outbox must bind signing credential'
   USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER dhf_pilot_gate_candidate_credential_audit_required
 AFTER INSERT ON dhf_pilot_gate_candidates DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_gate_candidate_credential_audit();
