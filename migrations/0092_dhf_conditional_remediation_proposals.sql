-- V0.8.0 slice 4. Conditional exception proposals are a NEVER-AUTHORIZED
-- planning ledger. No transition to accepted/conditionally_released and no
-- prepare/submit bypass is created. A corporate issuer does not yet exist.
CREATE TABLE dhf_pilot_conditional_remediation_proposals(
 id text PRIMARY KEY,
 project_id text NOT NULL REFERENCES dhf_pilot_projects(id) ON DELETE RESTRICT,
 stage_id text NOT NULL CHECK(stage_id IN ('G1','G2','G3','G4','G5','G6','G7','G8','G9')),
 template_id text NOT NULL REFERENCES dhf_pilot_templates(id) ON DELETE RESTRICT,
 policy_sha char(64) NOT NULL CHECK(policy_sha ~ '^[a-f0-9]{64}$'),
 proposed_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 dependency_id text NOT NULL,
 predecessor_stage text NOT NULL CHECK(predecessor_stage IN ('G1','G2','G3','G4','G5','G6','G7','G8','G9')),
 guarded_action text NOT NULL CHECK(guarded_action IN ('prepare','submit')),
 graph_snapshot jsonb NOT NULL CHECK(jsonb_typeof(graph_snapshot)='array'),
 graph_sha char(64) NOT NULL CHECK(graph_sha ~ '^[a-f0-9]{64}$'),
 obligations jsonb NOT NULL CHECK(jsonb_typeof(obligations)='array'
   AND jsonb_array_length(obligations) BETWEEN 1 AND 32),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 2000),
 expires_at timestamptz NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 160),
 request_sha char(64) NOT NULL CHECK(request_sha ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'awaiting_enterprise_authority'
   CHECK(state='awaiting_enterprise_authority'),
 trial_only boolean NOT NULL DEFAULT true CHECK(trial_only),
 formal_accepted boolean NOT NULL DEFAULT false CHECK(NOT formal_accepted),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(proposed_by,idempotency_key),
 UNIQUE(project_id,stage_id,template_id,dependency_id),
 FOREIGN KEY(project_id,stage_id,template_id)
  REFERENCES dhf_pilot_baselines(project_id,stage_id,template_id) ON DELETE RESTRICT,
 CHECK(stage_id<>predecessor_stage),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days')
);
CREATE INDEX ix_dhf_conditional_proposal_project
 ON dhf_pilot_conditional_remediation_proposals(project_id,stage_id,created_at DESC);
CREATE TRIGGER dhf_conditional_proposal_immutable
 BEFORE UPDATE OR DELETE ON dhf_pilot_conditional_remediation_proposals
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();

CREATE FUNCTION dhf_pilot_validate_conditional_proposal()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy jsonb;
DECLARE template_status text;
DECLARE source_policy_sha text;
DECLARE graph jsonb;
DECLARE edge jsonb;
DECLARE item jsonb;
DECLARE policy_requirement jsonb;
DECLARE current_source_state text;
DECLARE seen text[]:=ARRAY[]::text[];
BEGIN
 SELECT convert_from(t.policy_body,'UTF8')::jsonb,t.status,t.policy_sha
 INTO policy,template_status,source_policy_sha
 FROM dhf_pilot_baselines b
 JOIN dhf_pilot_templates t ON t.id=b.template_id AND t.stage_id=b.stage_id
 JOIN dhf_pilot_projects p ON p.id=b.project_id AND p.state='active'
 JOIN dhf_pilot_members member ON member.project_id=b.project_id
   AND member.user_id=NEW.proposed_by AND member.can_prepare
 JOIN users actor ON actor.id=member.user_id AND actor.disabled_at IS NULL
   AND NOT actor.must_change_password
 WHERE b.project_id=NEW.project_id AND b.stage_id=NEW.stage_id
   AND b.template_id=NEW.template_id AND b.active AND t.status='published'
   AND t.approved_by IS NOT NULL AND t.approved_at IS NOT NULL
   AND t.policy_sha=NEW.policy_sha
   AND encode(sha256(t.policy_body),'hex')=t.policy_sha
 FOR SHARE OF b,t,p,member,actor;
 IF policy IS NULL OR template_status<>'published' OR
    source_policy_sha IS DISTINCT FROM NEW.policy_sha THEN
  RAISE EXCEPTION 'conditional proposal requires authorized preparer and exact active published policy'
   USING ERRCODE='23514';
 END IF;
 -- DB builds full nine-stage DAG itself. Browser-supplied policy/graph
 -- and target permissions are never authoritative.
 graph:=dhf_pilot_verified_project_graph(NEW.project_id);
 NEW.graph_snapshot:=graph;
 NEW.graph_sha:=encode(sha256(convert_to(graph::text,'UTF8')),'hex');
 SELECT dep INTO edge FROM jsonb_array_elements(graph) node
 CROSS JOIN LATERAL jsonb_array_elements(node->'dependencies') dep
 WHERE node->>'stageId'=NEW.stage_id
  AND node->>'templateId'=NEW.template_id
  AND node->>'policySha'=NEW.policy_sha
  AND (node->>'conditionalTemplateFlag')::boolean IS TRUE
  AND dep->>'id'=NEW.dependency_id
  AND dep->>'predecessorStage'=NEW.predecessor_stage
  AND dep->>'guardedAction'=NEW.guarded_action
  AND (dep->>'allowConditional')::boolean IS TRUE;
 IF edge IS NULL THEN
  RAISE EXCEPTION 'conditional proposal cannot invent or widen a published direct dependency'
   USING ERRCODE='23514';
 END IF;
 SELECT node->>'positionState' INTO current_source_state
 FROM jsonb_array_elements(graph) node WHERE node->>'stageId'=NEW.predecessor_stage;
 IF current_source_state IS NULL OR current_source_state='accepted' THEN
  RAISE EXCEPTION 'conditional proposal cannot waive nonexistent or already accepted predecessor'
   USING ERRCODE='23514';
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.obligations) LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR
    item->>'requirementId' IS NULL OR
    length(btrim(item->>'requirementId'))=0 OR
    item->>'requirementId'=ANY(seen) OR
    item->>'ownerId' IS NULL OR
    length(btrim(item->>'ownerId'))=0 OR
    item->>'correctiveAction' IS NULL OR
    length(btrim(item->>'correctiveAction')) NOT BETWEEN 10 AND 1000 OR
    item->>'dueAt' IS NULL OR
    jsonb_typeof(item->'requirementId') IS DISTINCT FROM 'string' OR
    jsonb_typeof(item->'ownerId') IS DISTINCT FROM 'string' OR
    jsonb_typeof(item->'correctiveAction') IS DISTINCT FROM 'string' OR
    jsonb_typeof(item->'dueAt') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'each conditional correction requires unique evidence obligation and owner'
     USING ERRCODE='23514';
  END IF;
  SELECT req INTO policy_requirement FROM jsonb_array_elements(policy->'requirements') req
   WHERE req->>'ID'=item->>'requirementId';
  IF policy_requirement IS NULL OR
    (policy_requirement->>'Mandatory')::boolean IS DISTINCT FROM TRUE OR
    (policy_requirement->>'Critical')::boolean IS DISTINCT FROM FALSE OR
    (policy_requirement->>'ConditionEligible')::boolean IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'critical or noneligible DHF requirement cannot receive conditional exception'
     USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM dhf_pilot_members m
   JOIN users owner ON owner.id=m.user_id
   WHERE m.project_id=NEW.project_id AND m.user_id=item->>'ownerId'
     AND (m.can_prepare OR m.can_submit)
     AND owner.disabled_at IS NULL AND NOT owner.must_change_password) THEN
    RAISE EXCEPTION 'correction owner is not an active authorized project participant'
     USING ERRCODE='23514';
  END IF;
  BEGIN
   IF (item->>'dueAt')::timestamptz<=transaction_timestamp()
    OR (item->>'dueAt')::timestamptz>NEW.expires_at THEN
    RAISE EXCEPTION 'correction deadline outside pending proposal lifetime'
     USING ERRCODE='23514';
   END IF;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
   RAISE EXCEPTION 'invalid correction deadline timestamp' USING ERRCODE='23514';
  END;
  seen:=array_append(seen,item->>'requirementId');
 END LOOP;
 RETURN NEW;
END; $$;
CREATE TRIGGER dhf_conditional_proposal_source_guard
 BEFORE INSERT ON dhf_pilot_conditional_remediation_proposals
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_validate_conditional_proposal();

CREATE FUNCTION dhf_pilot_require_conditional_proposal_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM audit_events a WHERE
  a.event_type='dhf.pilot.conditional_proposal_filed'
  AND a.actor_id=NEW.proposed_by AND a.target_kind='dhf_conditional_proposal'
  AND a.target_id=NEW.id AND a.request_id=NEW.idempotency_key
  AND a.details->>'graphSha'=NEW.graph_sha
  AND a.details->>'projectId'=NEW.project_id
  AND a.details->>'stageId'=NEW.stage_id
  AND a.details->>'formalAccepted'='false')
 OR NOT EXISTS(SELECT 1 FROM outbox_jobs job
  WHERE job.id='dhf-conditional-proposal:'||NEW.id
  AND job.kind='dhf.pilot.conditional_proposal_filed'
  AND job.payload->>'proposalId'=NEW.id
  AND job.payload->>'graphSha'=NEW.graph_sha
  AND job.payload->>'trialOnly'='true'
  AND job.payload->>'formalAccepted'='false') THEN
  RAISE EXCEPTION 'conditional proposal requires same-transaction immutable audit and trial-only outbox'
   USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER dhf_conditional_proposal_audit_required
 AFTER INSERT ON dhf_pilot_conditional_remediation_proposals
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_require_conditional_proposal_audit();

-- Withdrawal is append-only. A pending proposal is never permission,
-- so expiry needs no background privileged state writer: status is derived
-- from the DB timestamp on every read.
CREATE TABLE dhf_pilot_conditional_proposal_withdrawals(
 id text PRIMARY KEY,
 proposal_id text NOT NULL UNIQUE REFERENCES dhf_pilot_conditional_remediation_proposals(id) ON DELETE RESTRICT,
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 1000),
 happened_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
-- Injected clock makes boundary behavior independently testable without
-- background mutation. Production callers MUST use transaction_timestamp().
CREATE FUNCTION dhf_pilot_conditional_proposal_status(
 deadline timestamptz, withdrawn timestamptz, evaluated_at timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE
  WHEN withdrawn IS NOT NULL THEN 'withdrawn'
  WHEN evaluated_at>=deadline THEN 'expired'
  ELSE 'awaiting_enterprise_authority'
 END
$$;
CREATE FUNCTION dhf_pilot_validate_conditional_withdrawal()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text;
BEGIN
 SELECT proposed_by INTO owner_id FROM dhf_pilot_conditional_remediation_proposals
 WHERE id=NEW.proposal_id FOR SHARE;
 IF owner_id IS NULL OR owner_id<>NEW.actor_id THEN
  RAISE EXCEPTION 'only original correction plan applicant may withdraw unapproved proposal'
   USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER dhf_conditional_proposal_withdraw_guard
 BEFORE INSERT ON dhf_pilot_conditional_proposal_withdrawals
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_validate_conditional_withdrawal();
CREATE TRIGGER dhf_conditional_proposal_withdraw_immutable
 BEFORE UPDATE OR DELETE ON dhf_pilot_conditional_proposal_withdrawals
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();
CREATE FUNCTION dhf_pilot_require_conditional_withdraw_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE
  a.actor_id=NEW.actor_id AND a.event_type='dhf.pilot.conditional_proposal_withdrawn'
  AND a.target_kind='dhf_conditional_proposal' AND a.target_id=NEW.proposal_id
  AND a.details->>'withdrawalId'=NEW.id)
 OR NOT EXISTS(SELECT 1 FROM outbox_jobs job
  WHERE job.id='dhf-conditional-withdraw:'||NEW.id
  AND job.kind='dhf.pilot.conditional_proposal_withdrawn'
  AND job.payload->>'proposalId'=NEW.proposal_id
  AND job.payload->>'formalAccepted'='false') THEN
  RAISE EXCEPTION 'withdrawn conditional proposal requires atomic immutable audit/outbox'
   USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER dhf_conditional_withdraw_audit_required
 AFTER INSERT ON dhf_pilot_conditional_proposal_withdrawals
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_require_conditional_withdraw_audit();
