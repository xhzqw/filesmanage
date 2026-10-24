-- DHF V0.6.2 controlled pilot: isolated schema; no runtime handler or
-- production approval/issuance path is enabled by this migration.
-- Templates are manually reviewed; importing original XMind creates no
-- published rules. G6 first transfer and G8 transfer are distinct stage IDs.

CREATE TABLE dhf_pilot_templates (
 id text PRIMARY KEY,
 stage_id text NOT NULL CHECK(stage_id IN ('G1','G2','G3','G4','G5','G6','G7','G8','G9')),
 policy_body bytea NOT NULL CHECK(octet_length(policy_body) BETWEEN 2 AND 1048576),
 policy_sha char(64) NOT NULL CHECK(policy_sha ~ '^[0-9a-f]{64}$'),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','withdrawn')),
 approved_by text REFERENCES users(id) ON DELETE RESTRICT,
 approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,stage_id),
 CHECK(status <> 'published' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX ix_dhf_pilot_template_stage ON dhf_pilot_templates(stage_id,status);

CREATE TABLE dhf_pilot_projects (
 id text PRIMARY KEY,
 owner_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','active','suspended','closed')),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dhf_pilot_members (
 project_id text NOT NULL REFERENCES dhf_pilot_projects(id) ON DELETE RESTRICT,
 user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 can_prepare boolean NOT NULL DEFAULT false,
 can_submit boolean NOT NULL DEFAULT false,
 PRIMARY KEY(project_id,user_id)
);

CREATE TABLE dhf_pilot_baselines (
 project_id text NOT NULL REFERENCES dhf_pilot_projects(id) ON DELETE RESTRICT,
 stage_id text NOT NULL,
 template_id text NOT NULL,
 active boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,stage_id),
 FOREIGN KEY(template_id,stage_id) REFERENCES dhf_pilot_templates(id,stage_id)
 ON DELETE RESTRICT,
 UNIQUE(project_id,stage_id,template_id)
);

-- Manifest is a frozen-by-hash input; the application verifies its SHA-256
-- before interpreting evidence. It never accepts request-supplied GateInput.
CREATE TABLE dhf_pilot_attempts (
 id text PRIMARY KEY,
 project_id text NOT NULL,
 stage_id text NOT NULL,
 template_id text NOT NULL,
 manifest_body bytea NOT NULL CHECK(octet_length(manifest_body) BETWEEN 2 AND 1048576),
 manifest_sha char(64) NOT NULL CHECK(manifest_sha ~ '^[0-9a-f]{64}$'),
 state text NOT NULL DEFAULT 'preparing' CHECK(state IN (
   'preparing','submitted','reviewing','changes_requested',
   'conditionally_released','accepted','cancelled'
 )),
 created_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,stage_id,template_id)
 REFERENCES dhf_pilot_baselines(project_id,stage_id,template_id) ON DELETE RESTRICT,
 UNIQUE(project_id,stage_id,id)
);
CREATE INDEX ix_dhf_pilot_attempt_project ON dhf_pilot_attempts(project_id,stage_id,created_at DESC);

-- A persisted stage projection is only a fact input. No stage decision API
-- writes it yet. No conditional grant is inferred from this projection.
CREATE TABLE dhf_pilot_stage_positions (
 project_id text NOT NULL REFERENCES dhf_pilot_projects(id) ON DELETE RESTRICT,
 stage_id text NOT NULL CHECK(stage_id IN ('G1','G2','G3','G4','G5','G6','G7','G8','G9')),
 -- No official decision service exists yet. The pilot database itself
 -- forbids fabricated accepted/conditionally_released predecessor states.
 state text NOT NULL CHECK(state IN (
   'preparing','submitted','reviewing','changes_requested','cancelled'
 )),
 decision_attempt_id text CHECK(decision_attempt_id IS NULL),
 changed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,stage_id),
 FOREIGN KEY(project_id,stage_id,decision_attempt_id)
 REFERENCES dhf_pilot_attempts(project_id,stage_id,id) ON DELETE RESTRICT,
 CHECK (decision_attempt_id IS NULL)
);

-- One-time template approval is intentionally not exposed as an application
-- command. Protect approved policy bytes and content hashes at SQL level.
CREATE FUNCTION dhf_pilot_reject_published_template_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='published' AND (
   NEW.policy_body IS DISTINCT FROM OLD.policy_body OR
   NEW.policy_sha IS DISTINCT FROM OLD.policy_sha OR
   NEW.stage_id IS DISTINCT FROM OLD.stage_id OR
   NEW.approved_by IS DISTINCT FROM OLD.approved_by OR
   NEW.approved_at IS DISTINCT FROM OLD.approved_at
 ) THEN
   RAISE EXCEPTION 'published DHF pilot template is immutable'
   USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dhf_pilot_published_immutable BEFORE UPDATE ON dhf_pilot_templates
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_published_template_change();

-- No rewriting historical non-draft attempts, including accepted evidence.
CREATE FUNCTION dhf_pilot_reject_frozen_attempt_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state <> 'preparing' AND (
   NEW.manifest_body IS DISTINCT FROM OLD.manifest_body OR
   NEW.manifest_sha IS DISTINCT FROM OLD.manifest_sha OR
   NEW.project_id IS DISTINCT FROM OLD.project_id OR
   NEW.stage_id IS DISTINCT FROM OLD.stage_id OR
   NEW.template_id IS DISTINCT FROM OLD.template_id OR
   NEW.created_by IS DISTINCT FROM OLD.created_by
 ) THEN
   RAISE EXCEPTION 'frozen DHF pilot attempt evidence is immutable'
   USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dhf_pilot_attempt_immutable BEFORE UPDATE ON dhf_pilot_attempts
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_frozen_attempt_change();

-- The pilot is NOT permitted to approve or issue files. No permissions in the
-- existing approval/CDW tables are granted or modified by this migration.
