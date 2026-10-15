-- CDW G1 schema draft 02/02: formal approvals, releases, plans, receipts and activation.
-- DESIGN ONLY: do NOT run directly in existing environments. Depends on base schema and
-- docs/design/CDW-G1-DDL-01-TASK-OFFICE.sql, in that order.
-- V1 has ONE global effective controlled release per file, not per department.

CREATE TABLE cdw_business_role_bindings (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK(role IN
 ('formal_approver','document_control','scope_approver','department_receiver',
  'receipt_proxy','manual_activator','withdrawal_officer')),
 file_id text REFERENCES files(id),
 department_id text REFERENCES departments(id),
 valid_from timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz,
 revoked_at timestamptz,
 granted_by text NOT NULL REFERENCES users(id),
 CHECK(file_id IS NULL OR department_id IS NULL),
 CHECK(role NOT IN ('department_receiver','receipt_proxy') OR department_id IS NOT NULL),
 CHECK(expires_at IS NULL OR expires_at>valid_from)
);
CREATE INDEX cdw_role_lookup_user ON cdw_business_role_bindings(user_id,role,revoked_at);

CREATE TABLE cdw_document_profiles (
 file_id text PRIMARY KEY REFERENCES files(id),
 controlled_code text,
 document_type text NOT NULL,
 managed boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
 CHECK(NOT managed OR controlled_code IS NOT NULL)
);

-- Freeze the exact bytes BEFORE approving them.
CREATE TABLE cdw_approval_subjects (
 id text PRIMARY KEY,
 file_id text NOT NULL REFERENCES files(id),
 source_kind text NOT NULL CHECK(source_kind IN ('delivery','integration','existing_version')),
 base_version_id text,
 delivery_id text REFERENCES cdw_deliveries(id),
 blob_id text NOT NULL REFERENCES blobs(id),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 size_bytes bigint NOT NULL CHECK(size_bytes>=0),
 lineage_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
 frozen_by text NOT NULL REFERENCES users(id),
 frozen_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,file_id),
 UNIQUE(id,file_id,sha256),
 CHECK((source_kind='delivery' AND delivery_id IS NOT NULL)
    OR (source_kind<>'delivery' AND delivery_id IS NULL)),
 FOREIGN KEY(file_id,base_version_id) REFERENCES file_versions(file_id,id),
 FOREIGN KEY(delivery_id,file_id,blob_id,sha256)
  REFERENCES cdw_delivery_items(delivery_id,file_id,blob_id,sha256)
);

CREATE TABLE cdw_formal_approval_instances (
 id text PRIMARY KEY,
 subject_id text NOT NULL REFERENCES cdw_approval_subjects(id),
 template_version_id text NOT NULL REFERENCES cdw_workflow_template_versions(id),
 state text NOT NULL CHECK(state IN ('pending','approved','rejected','cancelled','conflicted')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
 requested_by text NOT NULL REFERENCES users(id),
 requested_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 UNIQUE(id,subject_id),
 CHECK(state='pending' OR completed_at IS NOT NULL)
);
CREATE INDEX cdw_approval_pending ON cdw_formal_approval_instances(state,requested_at);
CREATE TABLE cdw_formal_approval_steps (
 id text PRIMARY KEY,
 instance_id text NOT NULL REFERENCES cdw_formal_approval_instances(id),
 node_key text NOT NULL,
 sequence_no integer NOT NULL CHECK(sequence_no>=1),
 approver_user_id text NOT NULL REFERENCES users(id),
 authority_binding_id text REFERENCES cdw_business_role_bindings(id),
 state text NOT NULL CHECK(state IN ('waiting','ready','approved','rejected','skipped')),
 mandatory boolean NOT NULL DEFAULT true,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
 UNIQUE(instance_id,node_key)
);
CREATE TABLE cdw_formal_approval_decisions (
 id text PRIMARY KEY,
 step_id text NOT NULL REFERENCES cdw_formal_approval_steps(id),
 actor_id text NOT NULL REFERENCES users(id),
 decision text NOT NULL CHECK(decision IN ('approve','reject')),
 reason text NOT NULL DEFAULT '',
 subject_sha256 text NOT NULL CHECK(subject_sha256 ~ '^[0-9a-f]{64}$'),
 actor_authority_snapshot jsonb NOT NULL,
 decided_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(step_id)
);
CREATE TABLE cdw_approved_candidates (
 id text PRIMARY KEY,
 subject_id text NOT NULL REFERENCES cdw_approval_subjects(id),
 file_id text NOT NULL,
 approval_instance_id text NOT NULL,
 content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
 approved_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(approval_instance_id),
 UNIQUE(id,file_id),
 FOREIGN KEY(subject_id,file_id,content_sha256)
  REFERENCES cdw_approval_subjects(id,file_id,sha256),
 FOREIGN KEY(approval_instance_id,subject_id)
  REFERENCES cdw_formal_approval_instances(id,subject_id)
);
-- Same subject may be resubmitted only through a new approval instance; a passing
-- candidate is created by the FINAL mandatory step transaction, never by a client.

-- Allocate stable release_id during preparation and never regenerate on issue.
CREATE TABLE cdw_controlled_releases (
 id text PRIMARY KEY,
 file_id text NOT NULL REFERENCES files(id),
 approved_candidate_id text NOT NULL,
 controlled_revision text NOT NULL CHECK(length(btrim(controlled_revision)) BETWEEN 1 AND 60),
 display_name_snapshot text NOT NULL,
 state text NOT NULL CHECK(state IN
 ('preparing','ready','issued_pending','effective','superseded','withdrawn','cancelled')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
 planned_effective_at timestamptz,
 actual_effective_at timestamptz,
 supersedes_release_id text,
 policy_snapshot jsonb NOT NULL CHECK(jsonb_typeof(policy_snapshot)='object'),
 prepared_by text NOT NULL REFERENCES users(id),
 prepared_at timestamptz NOT NULL DEFAULT now(),
 issued_by text REFERENCES users(id),
 issued_at timestamptz,
 UNIQUE(file_id,id),
 UNIQUE(file_id,controlled_revision),
 FOREIGN KEY(approved_candidate_id,file_id) REFERENCES cdw_approved_candidates(id,file_id),
 FOREIGN KEY(file_id,supersedes_release_id) REFERENCES cdw_controlled_releases(file_id,id),
 CHECK(state NOT IN ('issued_pending','effective','superseded') OR
       (issued_by IS NOT NULL AND issued_at IS NOT NULL))
);
CREATE INDEX cdw_releases_by_file ON cdw_controlled_releases(file_id,prepared_at DESC);

CREATE TABLE cdw_release_artifacts (
 id text PRIMARY KEY,
 release_id text NOT NULL REFERENCES cdw_controlled_releases(id),
 format text NOT NULL CHECK(format IN ('pdf','docx')),
 purpose text NOT NULL CHECK(purpose IN ('source','distribution','auxiliary')),
 blob_id text NOT NULL REFERENCES blobs(id),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 size_bytes bigint NOT NULL CHECK(size_bytes>=0),
 source_blob_id text REFERENCES blobs(id),
 conversion_job_id text,
 converter_version text,
 seal_revision_id text REFERENCES file_seal_revisions(id),
 marks_sha256 text CHECK(marks_sha256 IS NULL OR marks_sha256 ~ '^[0-9a-f]{64}$'),
 created_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(release_id,id),
 UNIQUE(release_id,id,sha256)
);
CREATE UNIQUE INDEX cdw_one_primary_distribution_artifact
 ON cdw_release_artifacts(release_id,format) WHERE purpose='distribution';
-- If both formats exist, the plan must explicitly choose one or both artifacts;
-- receipts always reference the actually served artifact_id/sha, never "latest".

CREATE TABLE cdw_distribution_plans (
 id text PRIMARY KEY,
 state text NOT NULL CHECK(state IN ('draft','frozen','approved','dispatched','cancelled')),
 digest_sha256 text CHECK(digest_sha256 IS NULL OR digest_sha256 ~ '^[0-9a-f]{64}$'),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
 created_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 frozen_at timestamptz,
 UNIQUE(id,digest_sha256),
 CHECK(state='draft' OR (digest_sha256 IS NOT NULL AND frozen_at IS NOT NULL)
   OR state='cancelled')
);
CREATE TABLE cdw_distribution_plan_items (
 plan_id text NOT NULL REFERENCES cdw_distribution_plans(id),
 ordinal integer NOT NULL CHECK(ordinal>=1),
 release_id text NOT NULL REFERENCES cdw_controlled_releases(id),
 artifact_id text NOT NULL,
 artifact_sha256 text NOT NULL CHECK(artifact_sha256 ~ '^[0-9a-f]{64}$'),
 required boolean NOT NULL DEFAULT true,
 PRIMARY KEY(plan_id,ordinal),
 UNIQUE(plan_id,ordinal,release_id,artifact_id,artifact_sha256,required),
 FOREIGN KEY(release_id,artifact_id,artifact_sha256)
  REFERENCES cdw_release_artifacts(release_id,id,sha256)
);
CREATE TABLE cdw_distribution_plan_targets (
 plan_id text NOT NULL REFERENCES cdw_distribution_plans(id),
 department_id text NOT NULL REFERENCES departments(id),
 designated_receiver_id text NOT NULL REFERENCES users(id),
 channel text NOT NULL CHECK(channel IN ('electronic','paper','mixed')),
 paper_quantity integer NOT NULL DEFAULT 0 CHECK(paper_quantity>=0),
 PRIMARY KEY(plan_id,department_id),
 UNIQUE(plan_id,department_id,designated_receiver_id),
 CHECK((channel='electronic' AND paper_quantity=0) OR
       (channel<>'electronic' AND paper_quantity>0))
);
-- Target/item requirements are frozen with the approved plan, not first chosen
-- during dispatch. Missing item rows mean this department is not sent that item.
CREATE TABLE cdw_distribution_plan_target_requirements (
 plan_id text NOT NULL,
 department_id text NOT NULL,
 item_ordinal integer NOT NULL CHECK(item_ordinal>=1),
 receipt_required boolean NOT NULL DEFAULT true,
 reading_required boolean NOT NULL DEFAULT false,
 implementation_required boolean NOT NULL DEFAULT false,
 PRIMARY KEY(plan_id,department_id,item_ordinal),
 UNIQUE(plan_id,department_id,item_ordinal,receipt_required,reading_required,implementation_required),
 FOREIGN KEY(plan_id,department_id) REFERENCES cdw_distribution_plan_targets(plan_id,department_id),
 FOREIGN KEY(plan_id,item_ordinal) REFERENCES cdw_distribution_plan_items(plan_id,ordinal)
);
CREATE TABLE cdw_distribution_scope_approvals (
 id text PRIMARY KEY,
 plan_id text NOT NULL UNIQUE REFERENCES cdw_distribution_plans(id),
 plan_digest_sha256 text NOT NULL CHECK(plan_digest_sha256 ~ '^[0-9a-f]{64}$'),
 approved_by text NOT NULL REFERENCES users(id),
 authority_binding_id text NOT NULL REFERENCES cdw_business_role_bindings(id),
 approver_role_snapshot jsonb NOT NULL,
 approved_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(plan_id,plan_digest_sha256)
  REFERENCES cdw_distribution_plans(id,digest_sha256)
);

CREATE TABLE cdw_distribution_batches (
 id text PRIMARY KEY,
 plan_id text NOT NULL UNIQUE REFERENCES cdw_distribution_plans(id),
 plan_digest_sha256 text NOT NULL CHECK(plan_digest_sha256 ~ '^[0-9a-f]{64}$'),
 state text NOT NULL CHECK(state IN ('draft','frozen','dispatched','withdrawn')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
 dispatched_by text REFERENCES users(id),
 dispatched_at timestamptz,
 UNIQUE(id,plan_id),
 FOREIGN KEY(plan_id,plan_digest_sha256)
  REFERENCES cdw_distribution_plans(id,digest_sha256),
 CHECK(state<>'dispatched' OR (dispatched_by IS NOT NULL AND dispatched_at IS NOT NULL))
);
CREATE TABLE cdw_distribution_batch_items (
 id text PRIMARY KEY,
 batch_id text NOT NULL REFERENCES cdw_distribution_batches(id),
 plan_id text NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal>=1),
 release_id text NOT NULL REFERENCES cdw_controlled_releases(id),
 artifact_id text NOT NULL,
 artifact_sha256 text NOT NULL CHECK(artifact_sha256 ~ '^[0-9a-f]{64}$'),
 required boolean NOT NULL DEFAULT true,
 UNIQUE(batch_id,ordinal),
 UNIQUE(id,batch_id),
 UNIQUE(id,batch_id,plan_id,ordinal),
 UNIQUE(id,batch_id,artifact_sha256),
 UNIQUE(release_id,id),
 UNIQUE(id,release_id,artifact_id),
 FOREIGN KEY(batch_id,plan_id) REFERENCES cdw_distribution_batches(id,plan_id),
 FOREIGN KEY(plan_id,ordinal,release_id,artifact_id,artifact_sha256,required)
  REFERENCES cdw_distribution_plan_items(plan_id,ordinal,release_id,artifact_id,artifact_sha256,required),
 FOREIGN KEY(release_id,artifact_id,artifact_sha256)
  REFERENCES cdw_release_artifacts(release_id,id,sha256)
);
CREATE TABLE cdw_distribution_targets (
 id text PRIMARY KEY,
 batch_id text NOT NULL REFERENCES cdw_distribution_batches(id),
 plan_id text NOT NULL,
 department_id text NOT NULL REFERENCES departments(id),
 designated_receiver_id text NOT NULL REFERENCES users(id),
 validity_state text NOT NULL DEFAULT 'active' CHECK(validity_state IN ('active','superseded','withdrawn')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
 due_at timestamptz,
 UNIQUE(id,batch_id),
 UNIQUE(id,batch_id,plan_id,department_id),
 UNIQUE(batch_id,department_id),
 FOREIGN KEY(batch_id,plan_id) REFERENCES cdw_distribution_batches(id,plan_id),
 FOREIGN KEY(plan_id,department_id,designated_receiver_id)
  REFERENCES cdw_distribution_plan_targets(plan_id,department_id,designated_receiver_id)
);
CREATE INDEX cdw_targets_department ON cdw_distribution_targets(department_id,validity_state,due_at);
CREATE TABLE cdw_target_item_requirements (
 target_id text NOT NULL,
 batch_id text NOT NULL,
 plan_id text NOT NULL,
 department_id text NOT NULL,
 batch_item_id text NOT NULL,
 item_ordinal integer NOT NULL CHECK(item_ordinal>=1),
 receipt_required boolean NOT NULL DEFAULT true,
 reading_required boolean NOT NULL DEFAULT false,
 implementation_required boolean NOT NULL DEFAULT false,
 PRIMARY KEY(target_id,batch_item_id),
 FOREIGN KEY(target_id,batch_id,plan_id,department_id)
  REFERENCES cdw_distribution_targets(id,batch_id,plan_id,department_id),
 FOREIGN KEY(batch_item_id,batch_id,plan_id,item_ordinal)
  REFERENCES cdw_distribution_batch_items(id,batch_id,plan_id,ordinal),
 FOREIGN KEY(plan_id,department_id,item_ordinal,receipt_required,reading_required,implementation_required)
  REFERENCES cdw_distribution_plan_target_requirements
  (plan_id,department_id,item_ordinal,receipt_required,reading_required,implementation_required)
);

CREATE TABLE cdw_department_receipts (
 id text PRIMARY KEY,
 target_id text NOT NULL REFERENCES cdw_distribution_targets(id),
 actor_id text NOT NULL REFERENCES users(id),
 authority_binding_id text NOT NULL REFERENCES cdw_business_role_bindings(id),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
 acknowledgement_text text NOT NULL CHECK(length(btrim(acknowledgement_text))>0),
 signed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 actor_role_snapshot jsonb NOT NULL,
 request_id text NOT NULL,
 evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 UNIQUE(target_id,id)
);
CREATE TABLE cdw_receipt_items (
 receipt_id text NOT NULL,
 target_id text NOT NULL,
 batch_id text NOT NULL,
 batch_item_id text NOT NULL,
 artifact_sha256 text NOT NULL CHECK(artifact_sha256 ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(receipt_id,batch_item_id),
 FOREIGN KEY(target_id,receipt_id) REFERENCES cdw_department_receipts(target_id,id),
 FOREIGN KEY(target_id,batch_id) REFERENCES cdw_distribution_targets(id,batch_id),
 FOREIGN KEY(batch_item_id,batch_id,artifact_sha256)
  REFERENCES cdw_distribution_batch_items(id,batch_id,artifact_sha256)
);
-- The effective receipt is defined ONLY here. The target's ack is derived on read,
-- not independently mutable. No receipt is updated when voided/corrected.
CREATE TABLE cdw_target_receipt_heads (
 target_id text PRIMARY KEY REFERENCES cdw_distribution_targets(id),
 current_receipt_id text,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
 changed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(target_id,current_receipt_id)
  REFERENCES cdw_department_receipts(target_id,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE cdw_reading_rosters (
 id text PRIMARY KEY,
 target_id text NOT NULL REFERENCES cdw_distribution_targets(id),
 revision integer NOT NULL CHECK(revision>=1),
 digest_sha256 text NOT NULL CHECK(digest_sha256 ~ '^[0-9a-f]{64}$'),
 created_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,target_id),
 UNIQUE(target_id,revision)
);
CREATE TABLE cdw_reading_assignments (
 id text PRIMARY KEY,
 roster_id text NOT NULL,
 target_id text NOT NULL,
 batch_id text NOT NULL,
 batch_item_id text NOT NULL,
 artifact_sha256 text NOT NULL CHECK(artifact_sha256 ~ '^[0-9a-f]{64}$'),
 user_id text NOT NULL REFERENCES users(id),
 state text NOT NULL CHECK(state IN ('assigned','opened','confirmed','exception','cancelled')),
 required boolean NOT NULL DEFAULT true,
 assigned_at timestamptz NOT NULL DEFAULT now(),
 confirmed_at timestamptz,
 UNIQUE(roster_id,user_id,batch_item_id),
 UNIQUE(id,artifact_sha256),
 FOREIGN KEY(roster_id,target_id) REFERENCES cdw_reading_rosters(id,target_id),
 FOREIGN KEY(target_id,batch_id) REFERENCES cdw_distribution_targets(id,batch_id),
 FOREIGN KEY(batch_item_id,batch_id,artifact_sha256)
  REFERENCES cdw_distribution_batch_items(id,batch_id,artifact_sha256),
 CHECK(state<>'confirmed' OR confirmed_at IS NOT NULL)
);
CREATE INDEX cdw_reading_user ON cdw_reading_assignments(user_id,state,assigned_at);
CREATE TABLE cdw_reading_events (
 id text PRIMARY KEY,
 assignment_id text NOT NULL REFERENCES cdw_reading_assignments(id),
 actor_id text NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('opened','confirmed','exception','cancelled')),
 artifact_sha256 text NOT NULL CHECK(artifact_sha256 ~ '^[0-9a-f]{64}$'),
 statement_snapshot text,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(assignment_id,artifact_sha256)
  REFERENCES cdw_reading_assignments(id,artifact_sha256)
);
CREATE UNIQUE INDEX cdw_one_confirmed_reading_event_per_assignment
 ON cdw_reading_events(assignment_id) WHERE kind='confirmed';

CREATE TABLE cdw_copy_issue_lots (
 id text PRIMARY KEY,
 target_id text NOT NULL,
 batch_item_id text NOT NULL,
 release_id text NOT NULL REFERENCES cdw_controlled_releases(id),
 issued_qty integer NOT NULL CHECK(issued_qty>=1),
 state text NOT NULL CHECK(state IN ('draft','frozen')),
 issued_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,release_id),
 FOREIGN KEY(target_id,batch_item_id) REFERENCES cdw_target_item_requirements(target_id,batch_item_id),
 FOREIGN KEY(release_id,batch_item_id) REFERENCES cdw_distribution_batch_items(release_id,id)
);
CREATE TABLE cdw_controlled_copies (
 id text PRIMARY KEY,
 lot_id text NOT NULL REFERENCES cdw_copy_issue_lots(id),
 release_id text NOT NULL REFERENCES cdw_controlled_releases(id),
 copy_no text NOT NULL,
 holder_id text REFERENCES users(id),
 UNIQUE(release_id,copy_no),
 UNIQUE(lot_id,copy_no),
 FOREIGN KEY(lot_id,release_id) REFERENCES cdw_copy_issue_lots(id,release_id)
);
CREATE TABLE cdw_withdrawal_events (
 id text PRIMARY KEY,
 copy_id text NOT NULL REFERENCES cdw_controlled_copies(id),
 actor_id text NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('collected','destroyed','lost','waived','corrected')),
 reason text NOT NULL DEFAULT '',
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(kind NOT IN ('lost','waived','corrected') OR length(btrim(reason))>0)
);

CREATE TABLE cdw_effective_pointers (
 file_id text PRIMARY KEY REFERENCES files(id),
 release_id text,
 state text NOT NULL CHECK(state IN ('active','none')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
 activated_at timestamptz,
 CHECK((state='active' AND release_id IS NOT NULL AND activated_at IS NOT NULL)
    OR (state='none' AND release_id IS NULL)),
 FOREIGN KEY(file_id,release_id) REFERENCES cdw_controlled_releases(file_id,id)
  DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE cdw_activation_attempts (
 id text PRIMARY KEY,
 release_id text NOT NULL REFERENCES cdw_controlled_releases(id),
 actor_id text REFERENCES users(id),
 outcome text NOT NULL CHECK(outcome IN ('activated','blocked','failed')),
 trigger_kind text NOT NULL CHECK(trigger_kind IN ('manual','scheduler','recovery')),
 blockers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(blockers)='array'),
 attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 idempotency_key text
);
CREATE TABLE cdw_release_access_grants (
 id text PRIMARY KEY,
 release_id text NOT NULL REFERENCES cdw_controlled_releases(id),
 artifact_id text,
 batch_item_id text,
 user_id text REFERENCES users(id),
 group_id text REFERENCES workgroups(id),
 actions text[] NOT NULL CHECK(cardinality(actions)>0 AND actions <@
    ARRAY['preview','read_confirm','download','print']::text[]),
 source_target_id text REFERENCES cdw_distribution_targets(id),
 expires_at timestamptz,
 revoked_at timestamptz,
 granted_by text NOT NULL REFERENCES users(id),
 FOREIGN KEY(release_id,artifact_id) REFERENCES cdw_release_artifacts(release_id,id),
 FOREIGN KEY(source_target_id,batch_item_id)
  REFERENCES cdw_target_item_requirements(target_id,batch_item_id),
 FOREIGN KEY(batch_item_id,release_id,artifact_id)
  REFERENCES cdw_distribution_batch_items(id,release_id,artifact_id),
 CHECK((source_target_id IS NULL AND batch_item_id IS NULL)
    OR (source_target_id IS NOT NULL AND batch_item_id IS NOT NULL AND artifact_id IS NOT NULL)),
 CHECK((user_id IS NULL)<>(group_id IS NULL))
);
CREATE INDEX cdw_grants_release_user ON cdw_release_access_grants(release_id,user_id,revoked_at);

CREATE TABLE cdw_review_anchors (
 id text PRIMARY KEY,
 file_id text NOT NULL REFERENCES files(id),
 branch_id text,
 branch_revision_id text,
 delivery_id text,
 approval_subject_id text,
 release_id text,
 target_sha256 text NOT NULL CHECK(target_sha256 ~ '^[0-9a-f]{64}$'),
 anchor jsonb NOT NULL CHECK(jsonb_typeof(anchor)='object'),
 created_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(branch_revision_id,delivery_id,approval_subject_id,release_id)=1),
 CHECK((branch_revision_id IS NULL)=(branch_id IS NULL)),
 FOREIGN KEY(branch_id,file_id) REFERENCES cdw_work_branches(id,file_id),
 FOREIGN KEY(branch_id,branch_revision_id) REFERENCES cdw_work_branch_revisions(branch_id,id),
 FOREIGN KEY(delivery_id,file_id) REFERENCES cdw_delivery_items(delivery_id,file_id),
 FOREIGN KEY(approval_subject_id,file_id) REFERENCES cdw_approval_subjects(id,file_id),
 FOREIGN KEY(file_id,release_id) REFERENCES cdw_controlled_releases(file_id,id)
);

-- Security-audit facts are append-only. Mutable aggregate state is changed only
-- through authorization-checked service commands; do not grant direct DML to clients.
CREATE TABLE cdw_domain_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 aggregate_kind text NOT NULL,
 aggregate_id text NOT NULL,
 event_kind text NOT NULL,
 actor_id text REFERENCES users(id),
 request_id text NOT NULL,
 details jsonb NOT NULL DEFAULT '{}'::jsonb,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX cdw_events_aggregate ON cdw_domain_events(aggregate_kind,aggregate_id,id);

-- Immutability barriers: only use on append-only facts, never on state projections.
CREATE FUNCTION cdw_prevent_fact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'CDW evidence is append-only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER cdw_approval_subject_immutable BEFORE UPDATE OR DELETE ON cdw_approval_subjects
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
CREATE TRIGGER cdw_approval_decision_immutable BEFORE UPDATE OR DELETE ON cdw_formal_approval_decisions
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
CREATE TRIGGER cdw_approved_candidate_immutable BEFORE UPDATE OR DELETE ON cdw_approved_candidates
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
CREATE TRIGGER cdw_release_artifact_immutable BEFORE UPDATE OR DELETE ON cdw_release_artifacts
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
CREATE TRIGGER cdw_scope_approval_immutable BEFORE UPDATE OR DELETE ON cdw_distribution_scope_approvals
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
CREATE TRIGGER cdw_receipt_immutable BEFORE UPDATE OR DELETE ON cdw_department_receipts
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
CREATE TRIGGER cdw_receipt_items_immutable BEFORE UPDATE OR DELETE ON cdw_receipt_items
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
CREATE TRIGGER cdw_reading_events_immutable BEFORE UPDATE OR DELETE ON cdw_reading_events
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
CREATE TRIGGER cdw_withdrawal_events_immutable BEFORE UPDATE OR DELETE ON cdw_withdrawal_events
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
CREATE TRIGGER cdw_activation_attempt_immutable BEFORE UPDATE OR DELETE ON cdw_activation_attempts
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
CREATE TRIGGER cdw_domain_event_immutable BEFORE UPDATE OR DELETE ON cdw_domain_events
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
-- Immutable work/approval artifacts cannot be updated by repair commands.
CREATE TRIGGER cdw_branch_revision_immutable BEFORE UPDATE OR DELETE ON cdw_work_branch_revisions
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
CREATE TRIGGER cdw_delivery_immutable BEFORE UPDATE OR DELETE ON cdw_deliveries
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
CREATE TRIGGER cdw_delivery_item_immutable BEFORE UPDATE OR DELETE ON cdw_delivery_items
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
CREATE TRIGGER cdw_review_decision_immutable BEFORE UPDATE OR DELETE ON cdw_review_decisions
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
CREATE TRIGGER cdw_manifest_version_immutable BEFORE UPDATE OR DELETE ON cdw_task_manifest_versions
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
CREATE TRIGGER cdw_manifest_item_immutable BEFORE UPDATE OR DELETE ON cdw_task_manifest_items
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
CREATE TRIGGER cdw_reading_roster_immutable BEFORE UPDATE OR DELETE ON cdw_reading_rosters
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
CREATE TRIGGER cdw_review_anchor_immutable BEFORE UPDATE OR DELETE ON cdw_review_anchors
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();

-- Draft plan/batch items freeze with their parent. Locking the parent serializes
-- child writes against concurrent freeze/dispatch transactions.
CREATE FUNCTION cdw_guard_distribution_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_state text; parent_id text;
BEGIN
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)->>'plan_id' IS DISTINCT FROM to_jsonb(OLD)->>'plan_id'
     OR to_jsonb(NEW)->>'batch_id' IS DISTINCT FROM to_jsonb(OLD)->>'batch_id') THEN
   RAISE EXCEPTION 'cannot move a distribution item to another parent';
 END IF;
 IF TG_TABLE_NAME LIKE 'cdw_distribution_plan_%' THEN
   parent_id := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD)->>'plan_id' ELSE to_jsonb(NEW)->>'plan_id' END;
   SELECT state INTO parent_state FROM cdw_distribution_plans WHERE id=parent_id FOR UPDATE;
 ELSE
   parent_id := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD)->>'batch_id' ELSE to_jsonb(NEW)->>'batch_id' END;
   SELECT state INTO parent_state FROM cdw_distribution_batches WHERE id=parent_id FOR UPDATE;
 END IF;
 IF parent_state IS NULL OR parent_state<>'draft' THEN
   RAISE EXCEPTION 'distribution plan or batch items are frozen';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_guard_plan_item BEFORE INSERT OR UPDATE OR DELETE ON cdw_distribution_plan_items
 FOR EACH ROW EXECUTE FUNCTION cdw_guard_distribution_child();
CREATE TRIGGER cdw_guard_plan_target BEFORE INSERT OR UPDATE OR DELETE ON cdw_distribution_plan_targets
 FOR EACH ROW EXECUTE FUNCTION cdw_guard_distribution_child();
CREATE TRIGGER cdw_guard_plan_target_requirement BEFORE INSERT OR UPDATE OR DELETE ON cdw_distribution_plan_target_requirements
 FOR EACH ROW EXECUTE FUNCTION cdw_guard_distribution_child();
CREATE TRIGGER cdw_guard_batch_item BEFORE INSERT OR UPDATE OR DELETE ON cdw_distribution_batch_items
 FOR EACH ROW EXECUTE FUNCTION cdw_guard_distribution_child();
CREATE TRIGGER cdw_guard_target_item_requirement BEFORE INSERT OR UPDATE OR DELETE ON cdw_target_item_requirements
 FOR EACH ROW EXECUTE FUNCTION cdw_guard_distribution_child();

-- Do not change the authoritative frozen plan digest, or a dispatched batch identity.
CREATE FUNCTION cdw_guard_frozen_plan_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state <> 'draft' AND (NEW.digest_sha256 IS DISTINCT FROM OLD.digest_sha256
   OR NEW.frozen_at IS DISTINCT FROM OLD.frozen_at OR NEW.state='draft') THEN
   RAISE EXCEPTION 'cannot modify a frozen distribution plan digest';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_frozen_plan_digest BEFORE UPDATE ON cdw_distribution_plans
 FOR EACH ROW EXECUTE FUNCTION cdw_guard_frozen_plan_identity();
CREATE FUNCTION cdw_guard_batch_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state <> 'draft' AND (NEW.plan_id IS DISTINCT FROM OLD.plan_id
   OR NEW.plan_digest_sha256 IS DISTINCT FROM OLD.plan_digest_sha256 OR NEW.state='draft') THEN
   RAISE EXCEPTION 'cannot rewrite a frozen distribution batch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_frozen_batch_digest BEFORE UPDATE ON cdw_distribution_batches
 FOR EACH ROW EXECUTE FUNCTION cdw_guard_batch_identity();

-- Target identity is frozen; only validity/due dates may change after dispatch.
CREATE FUNCTION cdw_guard_batch_target() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch_state text; parent_id text;
BEGIN
 parent_id := CASE WHEN TG_OP='DELETE' THEN OLD.batch_id ELSE NEW.batch_id END;
 SELECT state INTO batch_state FROM cdw_distribution_batches WHERE id=parent_id FOR UPDATE;
 IF TG_OP='UPDATE' AND (NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
     OR NEW.department_id IS DISTINCT FROM OLD.department_id
     OR NEW.designated_receiver_id IS DISTINCT FROM OLD.designated_receiver_id) THEN
   RAISE EXCEPTION 'cannot rewrite distribution target identity';
 END IF;
 IF TG_OP IN ('INSERT','DELETE') AND batch_state <> 'draft' THEN
   RAISE EXCEPTION 'cannot change frozen distribution targets';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_guard_batch_targets BEFORE INSERT OR UPDATE OR DELETE ON cdw_distribution_targets
 FOR EACH ROW EXECUTE FUNCTION cdw_guard_batch_target();

-- Freeze a paper lot only if the physical numbered copies were actually created.
CREATE FUNCTION cdw_validate_copy_lot_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_count bigint;
BEGIN
 IF NEW.state='frozen' AND OLD.state='draft' THEN
   SELECT count(*) INTO actual_count FROM cdw_controlled_copies WHERE lot_id=NEW.id;
   IF actual_count<>NEW.issued_qty THEN RAISE EXCEPTION 'copy count does not match issue lot'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_copy_lot_freeze BEFORE UPDATE OF state ON cdw_copy_issue_lots
 FOR EACH ROW EXECUTE FUNCTION cdw_validate_copy_lot_freeze();
CREATE FUNCTION cdw_guard_copy_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lot_state text; effective_lot text;
BEGIN
 effective_lot := CASE WHEN TG_OP='INSERT' THEN NEW.lot_id ELSE OLD.lot_id END;
 SELECT state INTO lot_state FROM cdw_copy_issue_lots WHERE id=effective_lot FOR UPDATE;
 IF lot_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'cannot mutate copies of frozen lot';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.lot_id IS DISTINCT FROM OLD.lot_id
   OR NEW.release_id IS DISTINCT FROM OLD.release_id OR NEW.copy_no IS DISTINCT FROM OLD.copy_no) THEN
    RAISE EXCEPTION 'cannot reassign copy identity';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_copy_guard_mutation BEFORE INSERT OR UPDATE OR DELETE ON cdw_controlled_copies
 FOR EACH ROW EXECUTE FUNCTION cdw_guard_copy_mutation();

-- Freeze/issue/dispatch must additionally check item count >=1, actual plan
-- canonical SHA digest, exact approved target/quantity snapshot, and same-release
-- artifact digest IN THE DATABASE TRANSACTION. CHECK alone cannot express these.
-- All sensitive outbox events must be created with the related domain state commit;
-- WebSocket is a private notification transport, never the canonical audit log.
