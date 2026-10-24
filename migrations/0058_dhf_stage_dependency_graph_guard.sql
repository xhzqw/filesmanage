-- V0.8.0 slice 2: full-project, explicit published baseline DAG validation.
-- Never manufacture G1->G2->...->G9. No formal Gate decision is enabled.
-- Legacy V0.8.0 intake remains readable with nullable project graph fields.
ALTER TABLE dhf_pilot_stage_gate_review_intents
  ADD COLUMN project_graph_snapshot jsonb,
  ADD COLUMN project_graph_sha char(64),
  ADD CONSTRAINT dhf_gate_graph_presence_pair CHECK
   ((project_graph_snapshot IS NULL)=(project_graph_sha IS NULL)),
  ADD CONSTRAINT dhf_gate_graph_snapshot_array CHECK
   (project_graph_snapshot IS NULL OR jsonb_typeof(project_graph_snapshot)='array'),
  ADD CONSTRAINT dhf_gate_graph_sha_valid CHECK
   (project_graph_sha IS NULL OR project_graph_sha ~ '^[0-9a-f]{64}$');

-- The builder verifies every active project baseline, rather than trusting a
-- filtered set of edges provided by the requesting Gate reviewer.
CREATE FUNCTION dhf_pilot_verified_project_graph(project text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE node record;
DECLARE edge jsonb;
DECLARE doc jsonb;
DECLARE stage_edges jsonb;
DECLARE graph jsonb := '[]'::jsonb;
DECLARE assigned_count integer;
DECLARE edge_ids text[];
DECLARE predecessor text;
DECLARE guarded text;
DECLARE conditional boolean;
BEGIN
 IF project IS NULL OR NOT EXISTS (
  SELECT 1 FROM dhf_pilot_projects p WHERE p.id=project AND p.state='active'
 ) THEN
  RAISE EXCEPTION 'DHF dependency graph requires active project'
    USING ERRCODE='23514';
 END IF;
 FOR node IN
  SELECT b.stage_id,b.template_id,t.policy_body,t.policy_sha,t.status,
   t.approved_by,t.approved_at,
   COALESCE(position.state,'preparing') AS observed_state
  FROM dhf_pilot_baselines b
  JOIN dhf_pilot_templates t ON t.id=b.template_id AND t.stage_id=b.stage_id
  LEFT JOIN dhf_pilot_stage_positions position
   ON position.project_id=b.project_id AND position.stage_id=b.stage_id
  WHERE b.project_id=project AND b.active
  ORDER BY b.stage_id
 LOOP
  IF node.status<>'published' OR node.approved_by IS NULL OR
    node.approved_at IS NULL OR
    encode(sha256(node.policy_body),'hex')<>node.policy_sha THEN
   RAISE EXCEPTION 'active DHF baseline must bind approved untampered published template'
     USING ERRCODE='23514';
  END IF;
  BEGIN
   doc:=convert_from(node.policy_body,'UTF8')::jsonb;
  EXCEPTION WHEN others THEN
   RAISE EXCEPTION 'active DHF baseline policy JSON malformed'
     USING ERRCODE='23514';
  END;
  IF doc->>'stage_id' IS DISTINCT FROM node.stage_id OR
    jsonb_typeof(doc->'dependencies') IS DISTINCT FROM 'array' OR
    jsonb_array_length(doc->'dependencies')>256 OR
    jsonb_typeof(doc->'requirements') IS DISTINCT FROM 'array' OR
    jsonb_array_length(doc->'requirements')=0 OR
    jsonb_typeof(doc->'conditional_allowed') IS DISTINCT FROM 'boolean'
  THEN
   RAISE EXCEPTION 'active DHF baseline missing full stage dependency policy'
     USING ERRCODE='23514';
  END IF;
  stage_edges:='[]'::jsonb;
  edge_ids:=ARRAY[]::text[];
  FOR edge IN SELECT value FROM jsonb_array_elements(doc->'dependencies') LOOP
   predecessor:=edge->>'PredecessorStage';
   guarded:=edge->>'GuardedAction';
   IF edge->>'ID' IS NULL OR btrim(edge->>'ID')='' OR
     edge->>'ID'=ANY(edge_ids) OR
     predecessor IS NULL OR predecessor NOT IN
       ('G1','G2','G3','G4','G5','G6','G7','G8','G9') OR
     predecessor=node.stage_id OR
     guarded NOT IN ('prepare','submit','conditional_approve','finalize','issue_document')
   THEN
    RAISE EXCEPTION 'DHF dependency edge is invalid, duplicated or self-linked'
      USING ERRCODE='23514';
   END IF;
   IF jsonb_typeof(edge->'AllowConditional') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'DHF dependency missing explicit conditional-scope decision'
      USING ERRCODE='23514';
   END IF;
   conditional:=(edge->>'AllowConditional')::boolean;
   IF conditional AND guarded NOT IN ('prepare','submit') THEN
    RAISE EXCEPTION 'DHF conditional edge cannot grant issue or finalize action'
      USING ERRCODE='23514';
   END IF;
   IF NOT EXISTS (
    SELECT 1 FROM dhf_pilot_baselines pre
    JOIN dhf_pilot_templates t ON t.id=pre.template_id AND t.stage_id=pre.stage_id
    WHERE pre.project_id=project AND pre.stage_id=predecessor
      AND pre.active AND t.status='published' AND t.approved_by IS NOT NULL
      AND t.approved_at IS NOT NULL
      AND encode(sha256(t.policy_body),'hex')=t.policy_sha
   ) THEN
    RAISE EXCEPTION 'DHF explicitly required predecessor has no active published baseline'
      USING ERRCODE='23514';
   END IF;
   edge_ids:=array_append(edge_ids,edge->>'ID');
   stage_edges:=stage_edges||jsonb_build_array(jsonb_build_object(
    'id',edge->>'ID','predecessorStage',predecessor,
    'guardedAction',guarded,'allowConditional',conditional
   ));
  END LOOP;
  SELECT COALESCE(jsonb_agg(value ORDER BY value->>'id'),'[]'::jsonb)
  INTO stage_edges FROM jsonb_array_elements(stage_edges);
  graph:=graph||jsonb_build_array(jsonb_build_object(
    'stageId',node.stage_id,'templateId',node.template_id,
    'policySha',node.policy_sha,'positionState',node.observed_state,
    'conditionalTemplateFlag',(doc->>'conditional_allowed')::boolean,
    'dependencies',stage_edges
  ));
 END LOOP;
 SELECT count(*) INTO assigned_count FROM dhf_pilot_baselines b
  WHERE b.project_id=project AND b.active;
 IF assigned_count=0 THEN
  RAISE EXCEPTION 'DHF project has no published baseline' USING ERRCODE='23514';
 END IF;
 -- Traversal uses only edges that were already verified against the same
 -- project's active published baseline; any cycle is fatal, including one
 -- spanning more than two stages.
 IF EXISTS (
  WITH RECURSIVE edges AS (
    SELECT n->>'stageId' AS stage_id,d->>'predecessorStage' AS predecessor
    FROM jsonb_array_elements(graph) n
    CROSS JOIN LATERAL jsonb_array_elements(n->'dependencies') d
  ), walk AS (
    SELECT stage_id,predecessor,ARRAY[stage_id]::text[] AS visited
    FROM edges
    UNION ALL
    SELECT w.stage_id,e.predecessor,w.visited||w.predecessor
    FROM walk w JOIN edges e ON e.stage_id=w.predecessor
    WHERE w.predecessor<>ALL(w.visited)
  )
  SELECT 1 FROM walk WHERE predecessor=ANY(visited)
 ) THEN
  RAISE EXCEPTION 'cyclic G1-G9 project dependency graph is forbidden'
    USING ERRCODE='23514';
 END IF;
 RETURN graph;
END; $$;

-- AFTER the original stage-specific check has reconstructed the exact
-- Gate's own dependency snapshot, freeze the entire cross-stage graph too.
CREATE FUNCTION dhf_pilot_freeze_stage_gate_graph()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.project_graph_snapshot:=dhf_pilot_verified_project_graph(NEW.project_id);
 NEW.project_graph_sha:=encode(
  sha256(convert_to(NEW.project_graph_snapshot::text,'UTF8')),'hex');
 IF NOT EXISTS (
  SELECT 1 FROM jsonb_array_elements(NEW.project_graph_snapshot) node
  WHERE node->>'stageId'=NEW.stage_id AND node->>'templateId'=NEW.template_id
    AND node->>'policySha'=NEW.policy_sha
 ) THEN
  RAISE EXCEPTION 'Gate source is not in verified project graph'
    USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER zz_dhf_pilot_stage_gate_graph_guard
 BEFORE INSERT ON dhf_pilot_stage_gate_review_intents
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_freeze_stage_gate_graph();

CREATE OR REPLACE FUNCTION dhf_pilot_gate_review_intent_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.project_graph_sha IS NULL OR NOT EXISTS (
   SELECT 1 FROM audit_events e
   WHERE e.actor_id=NEW.signer_id
   AND e.event_type='dhf.pilot.gate.review_requested'
   AND e.target_kind='dhf_stage_gate_review'
   AND e.target_id=NEW.id AND e.request_id=NEW.idempotency_key
   AND e.details->>'dependencySnapshotSha'=NEW.dependency_snapshot_sha
   AND e.details->>'projectGraphSha'=NEW.project_graph_sha
   AND e.details->>'candidateId'=NEW.gate_candidate_id
   AND e.details->>'formalAccepted'='false'
 ) OR NOT EXISTS (
   SELECT 1 FROM outbox_jobs job
   WHERE job.id='dhf-gate-review:'||NEW.id
    AND job.kind='dhf.pilot.gate.review_requested'
    AND job.payload->>'reviewId'=NEW.id
    AND job.payload->>'candidateId'=NEW.gate_candidate_id
    AND job.payload->>'projectGraphSha'=NEW.project_graph_sha
    AND job.payload->>'trialOnly'='true'
    AND job.payload->>'formalAccepted'='false'
 ) THEN
   RAISE EXCEPTION 'Stage Gate project graph and intake audit/outbox must be atomic'
     USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;
