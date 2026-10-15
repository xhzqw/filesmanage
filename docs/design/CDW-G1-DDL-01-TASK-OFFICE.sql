-- CDW G1 schema draft 01/02: task graph, branches, ONLYOFFICE, immutable deliveries.
-- DESIGN ONLY. DO NOT place under migrations/ or execute on a live database.
-- Assumes existing migrations through 0045: users/files/file_versions/blobs/workgroups/departments.
-- Requires PostgreSQL 17. Table names intentionally prefixed cdw_.
-- All new resources are protected by application authorization; direct DML is privileged.
-- Existing file_versions is NOT a branch revision and files.current_version_seq is NOT effective.
-- Use one exclusive writer in noncollaborative branch; collaborative users join a shared session/key.

-- Enable precise same-file composite FKs without changing the legacy unique seq.
CREATE UNIQUE INDEX IF NOT EXISTS cdw_file_versions_file_id_id_uq ON file_versions(file_id,id);

CREATE TABLE cdw_workgroup_role_bindings (
 id text PRIMARY KEY,
 group_id text NOT NULL REFERENCES workgroups(id),
 user_id text NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK(role IN ('leader','deputy')),
 valid_from timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz,
 revoked_at timestamptz,
 granted_by text NOT NULL REFERENCES users(id),
 CHECK(expires_at IS NULL OR expires_at > valid_from)
);
-- Expired leaders must be revoked when rotating; expiry is rechecked at action time.
CREATE UNIQUE INDEX cdw_workgroup_one_nonrevoked_leader
 ON cdw_workgroup_role_bindings(group_id) WHERE role='leader' AND revoked_at IS NULL;
CREATE INDEX cdw_workgroup_role_user ON cdw_workgroup_role_bindings(user_id,group_id);

CREATE TABLE cdw_workflow_template_versions (
 id text PRIMARY KEY,
 template_key text NOT NULL,
 version_no integer NOT NULL CHECK(version_no >= 1),
 lifecycle text NOT NULL CHECK(lifecycle IN ('draft','published','retired')),
 graph jsonb NOT NULL CHECK(jsonb_typeof(graph)='object'),
 role_policy jsonb NOT NULL CHECK(jsonb_typeof(role_policy)='object'),
 published_at timestamptz,
 created_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(template_key,version_no),
 CHECK(lifecycle <> 'published' OR published_at IS NOT NULL)
);

CREATE TABLE cdw_tasks (
 id text PRIMARY KEY,
 root_id text NOT NULL,
 parent_id text,
 template_version_id text NOT NULL REFERENCES cdw_workflow_template_versions(id),
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 255),
 subject_kind text NOT NULL CHECK(subject_kind IN ('file','folder_manifest','general')),
 file_id text REFERENCES files(id),
 state text NOT NULL CHECK(state IN
  ('draft','assigned','accepted','in_progress','submitted','accepted_delivery','returned','declined','closed','cancelled')),
 round_no integer NOT NULL DEFAULT 1 CHECK(round_no >= 1),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision >= 1),
 created_by text NOT NULL REFERENCES users(id),
 due_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,root_id),
 FOREIGN KEY(root_id) REFERENCES cdw_tasks(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(parent_id,root_id) REFERENCES cdw_tasks(id,root_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(parent_id IS NULL OR parent_id <> id),
 CHECK((parent_id IS NULL AND root_id = id) OR (parent_id IS NOT NULL AND root_id <> id)),
 CHECK ((subject_kind='file' AND file_id IS NOT NULL)
   OR (subject_kind<>'file' AND file_id IS NULL))
);
CREATE INDEX cdw_tasks_by_root ON cdw_tasks(root_id,parent_id);
CREATE INDEX cdw_tasks_by_state ON cdw_tasks(state,due_at,id);

CREATE TABLE cdw_task_assignments (
 id text PRIMARY KEY,
 task_id text NOT NULL REFERENCES cdw_tasks(id),
 assigned_by text NOT NULL REFERENCES users(id),
 user_id text REFERENCES users(id),
 group_id text REFERENCES workgroups(id),
 kind text NOT NULL CHECK(kind IN ('primary','support')),
 offered_at timestamptz NOT NULL DEFAULT now(),
 accepted_by text REFERENCES users(id),
 accepted_at timestamptz,
 ended_at timestamptz,
 authority_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
 CHECK ((user_id IS NULL) <> (group_id IS NULL)),
 CHECK ((accepted_by IS NULL)=(accepted_at IS NULL)),
 CHECK (ended_at IS NULL OR ended_at >= offered_at)
);
CREATE UNIQUE INDEX cdw_one_primary_assignment
 ON cdw_task_assignments(task_id) WHERE kind='primary' AND ended_at IS NULL;
CREATE INDEX cdw_task_assignee_user ON cdw_task_assignments(user_id,ended_at);
CREATE INDEX cdw_task_assignee_group ON cdw_task_assignments(group_id,ended_at);

CREATE TABLE cdw_task_manifest_versions (
 id text PRIMARY KEY,
 root_task_id text NOT NULL REFERENCES cdw_tasks(id),
 version_no integer NOT NULL CHECK(version_no >= 1),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
 frozen_at timestamptz NOT NULL DEFAULT now(),
 frozen_by text NOT NULL REFERENCES users(id),
 change_reason text NOT NULL DEFAULT '',
 UNIQUE(root_task_id,version_no)
);
CREATE TABLE cdw_task_manifest_items (
 manifest_version_id text NOT NULL REFERENCES cdw_task_manifest_versions(id),
 ordinal integer NOT NULL CHECK(ordinal>=1),
 file_id text NOT NULL REFERENCES files(id),
 base_version_id text NOT NULL,
 base_sha256 text NOT NULL CHECK(base_sha256 ~ '^[0-9a-f]{64}$'),
 path_snapshot text NOT NULL,
 required boolean NOT NULL DEFAULT true,
 PRIMARY KEY(manifest_version_id,ordinal),
 UNIQUE(manifest_version_id,file_id),
 FOREIGN KEY(file_id,base_version_id) REFERENCES file_versions(file_id,id)
);
CREATE INDEX cdw_manifest_item_file ON cdw_task_manifest_items(file_id);

CREATE TABLE cdw_task_dependencies (
 task_id text NOT NULL REFERENCES cdw_tasks(id),
 depends_on_task_id text NOT NULL REFERENCES cdw_tasks(id),
 dependency_kind text NOT NULL CHECK(dependency_kind IN ('finish_before_start','finish_before_close')),
 PRIMARY KEY(task_id,depends_on_task_id),
 CHECK(task_id<>depends_on_task_id)
);
-- The application must serialize graph edits with a global DB advisory transaction lock;
-- no plain FK/CHECK can detect multi-edge cycles or cross-root races.

CREATE TABLE cdw_override_grants (
 id text PRIMARY KEY,
 granted_by text NOT NULL REFERENCES users(id),
 actor_id text NOT NULL REFERENCES users(id),
 task_id text NOT NULL REFERENCES cdw_tasks(id),
 actions text[] NOT NULL CHECK(cardinality(actions)>0 AND
     actions <@ ARRAY['inspect','request_changes','substitute_review_gate','escalate','waive_obligation']::text[]),
 reason text NOT NULL CHECK(length(btrim(reason))>0),
 valid_from timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 CHECK(expires_at>valid_from)
);

CREATE TABLE cdw_accountability_obligations (
 id text PRIMARY KEY,
 task_id text NOT NULL REFERENCES cdw_tasks(id),
 responsible_user_id text NOT NULL REFERENCES users(id),
 assignment_id text REFERENCES cdw_task_assignments(id),
 obligation_kind text NOT NULL CHECK(obligation_kind IN ('manage','integrate','report','acknowledge_override')),
 state text NOT NULL CHECK(state IN ('pending','fulfilled','waived','cancelled')),
 fulfilled_at timestamptz,
 waiver_grant_id text REFERENCES cdw_override_grants(id),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
 CHECK(state <> 'fulfilled' OR fulfilled_at IS NOT NULL),
 CHECK(state <> 'waived' OR waiver_grant_id IS NOT NULL)
);
CREATE INDEX cdw_obligations_user_state ON cdw_accountability_obligations(responsible_user_id,state);

CREATE TABLE cdw_work_branches (
 id text PRIMARY KEY,
 task_id text NOT NULL REFERENCES cdw_tasks(id),
 file_id text NOT NULL REFERENCES files(id),
 base_version_id text NOT NULL,
 base_sha256 text NOT NULL CHECK(base_sha256 ~ '^[0-9a-f]{64}$'),
 head_revision_id text,
 collaboration_enabled boolean NOT NULL DEFAULT false,
 edit_epoch bigint NOT NULL DEFAULT 1 CHECK(edit_epoch >= 1),
 state text NOT NULL CHECK(state IN ('open','fencing','frozen','closed','cancelled')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
 created_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,file_id),
 FOREIGN KEY(file_id,base_version_id) REFERENCES file_versions(file_id,id)
);
CREATE INDEX cdw_work_branches_file ON cdw_work_branches(file_id,task_id);
CREATE TABLE cdw_work_branch_revisions (
 id text PRIMARY KEY,
 branch_id text NOT NULL REFERENCES cdw_work_branches(id),
 ordinal integer NOT NULL CHECK(ordinal>=1),
 parent_revision_id text,
 blob_id text NOT NULL REFERENCES blobs(id),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 size_bytes bigint NOT NULL CHECK(size_bytes>=0),
 save_epoch bigint NOT NULL CHECK(save_epoch>=1),
 saved_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(branch_id,ordinal),
 UNIQUE(branch_id,id),
 UNIQUE(branch_id,id,blob_id,sha256),
 FOREIGN KEY(branch_id,parent_revision_id) REFERENCES cdw_work_branch_revisions(branch_id,id)
   DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE cdw_work_branches ADD CONSTRAINT cdw_branch_head_same_branch
 FOREIGN KEY(id,head_revision_id) REFERENCES cdw_work_branch_revisions(branch_id,id)
 DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE cdw_office_branch_sessions (
 id text PRIMARY KEY,
 branch_id text NOT NULL REFERENCES cdw_work_branches(id),
 document_key text NOT NULL UNIQUE,
 mode text NOT NULL CHECK(mode IN ('exclusive','collaborative')),
 generation bigint NOT NULL DEFAULT 1 CHECK(generation>=1),
 edit_epoch bigint NOT NULL CHECK(edit_epoch>=1),
 state text NOT NULL CHECK(state IN ('open','saving','closing','closed','failed')),
 opened_by text NOT NULL REFERENCES users(id),
 opened_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 ended_at timestamptz,
 UNIQUE(id,branch_id),
 CHECK(ended_at IS NULL OR ended_at>=opened_at)
);
CREATE UNIQUE INDEX cdw_one_live_office_session ON cdw_office_branch_sessions(branch_id)
 WHERE ended_at IS NULL;
CREATE TABLE cdw_office_branch_participants (
 session_id text NOT NULL REFERENCES cdw_office_branch_sessions(id),
 user_id text NOT NULL REFERENCES users(id),
 permission text NOT NULL CHECK(permission IN ('edit','read')),
 joined_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 PRIMARY KEY(session_id,user_id)
);
CREATE TABLE cdw_office_save_requests (
 id text PRIMARY KEY,
 session_id text NOT NULL,
 branch_id text NOT NULL,
 requested_by text NOT NULL REFERENCES users(id),
 requested_generation bigint NOT NULL CHECK(requested_generation>=1),
 requested_epoch bigint NOT NULL CHECK(requested_epoch>=1),
 state text NOT NULL CHECK(state IN ('requested','accepted','persisted','failed','unknown')),
 requested_at timestamptz NOT NULL DEFAULT now(),
 persisted_revision_id text,
 completed_at timestamptz,
 UNIQUE(id,session_id),
 FOREIGN KEY(session_id,branch_id) REFERENCES cdw_office_branch_sessions(id,branch_id),
 FOREIGN KEY(branch_id,persisted_revision_id) REFERENCES cdw_work_branch_revisions(branch_id,id),
 CHECK(state <> 'persisted' OR (persisted_revision_id IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX cdw_save_request_pending ON cdw_office_save_requests(branch_id,requested_at)
 WHERE state IN ('requested','accepted','unknown');

CREATE TABLE cdw_office_callback_events (
 id text PRIMARY KEY,
 session_id text NOT NULL REFERENCES cdw_office_branch_sessions(id),
 event_hash text NOT NULL CHECK(event_hash ~ '^[0-9a-f]{64}$'),
 request_id text,
 callback_status integer NOT NULL,
 outcome text NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(session_id,event_hash),
 FOREIGN KEY(request_id,session_id) REFERENCES cdw_office_save_requests(id,session_id)
);

CREATE TABLE cdw_delivery_freezes (
 id text PRIMARY KEY,
 task_id text NOT NULL REFERENCES cdw_tasks(id),
 round_no integer NOT NULL CHECK(round_no>=1),
 state text NOT NULL CHECK(state IN ('fencing','committed','failed')),
 fenced_epoch bigint NOT NULL CHECK(fenced_epoch>=1),
 started_by text NOT NULL REFERENCES users(id),
 started_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 UNIQUE(task_id,round_no),
 UNIQUE(id,task_id,round_no),
 CHECK(state <> 'committed' OR completed_at IS NOT NULL)
);

CREATE TABLE cdw_deliveries (
 id text PRIMARY KEY,
 task_id text NOT NULL REFERENCES cdw_tasks(id),
 freeze_id text NOT NULL UNIQUE,
 round_no integer NOT NULL CHECK(round_no>=1),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
 submitted_by text NOT NULL REFERENCES users(id),
 submitted_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(task_id,round_no),
 UNIQUE(id,task_id),
 UNIQUE(id,round_no),
 FOREIGN KEY(freeze_id,task_id,round_no)
  REFERENCES cdw_delivery_freezes(id,task_id,round_no)
);
CREATE TABLE cdw_delivery_items (
 delivery_id text NOT NULL REFERENCES cdw_deliveries(id),
 ordinal integer NOT NULL CHECK(ordinal>=1),
 file_id text NOT NULL REFERENCES files(id),
 branch_id text NOT NULL,
 branch_revision_id text NOT NULL,
 blob_id text NOT NULL REFERENCES blobs(id),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(delivery_id,ordinal),
 UNIQUE(delivery_id,file_id),
 UNIQUE(delivery_id,file_id,blob_id,sha256),
 FOREIGN KEY(branch_id,file_id) REFERENCES cdw_work_branches(id,file_id),
 FOREIGN KEY(branch_id,branch_revision_id,blob_id,sha256)
  REFERENCES cdw_work_branch_revisions(branch_id,id,blob_id,sha256)
);
CREATE TABLE cdw_review_gates (
 id text PRIMARY KEY,
 delivery_id text NOT NULL REFERENCES cdw_deliveries(id),
 node_key text NOT NULL,
 round_no integer NOT NULL CHECK(round_no>=1),
 responsible_user_id text NOT NULL REFERENCES users(id),
 substitutable boolean NOT NULL DEFAULT false,
 state text NOT NULL CHECK(state IN ('awaiting','accepted','returned','substituted','cancelled')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
 UNIQUE(delivery_id,node_key,round_no),
 UNIQUE(id,delivery_id,round_no),
 FOREIGN KEY(delivery_id,round_no) REFERENCES cdw_deliveries(id,round_no)
);
CREATE INDEX cdw_review_gate_inbox ON cdw_review_gates(responsible_user_id,state);
CREATE TABLE cdw_review_decisions (
 id text PRIMARY KEY,
 gate_id text NOT NULL REFERENCES cdw_review_gates(id),
 actor_id text NOT NULL REFERENCES users(id),
 acting_for_id text REFERENCES users(id),
 override_grant_id text REFERENCES cdw_override_grants(id),
 decision text NOT NULL CHECK(decision IN ('accept','return')),
 reason text NOT NULL DEFAULT '',
 is_final boolean NOT NULL DEFAULT true,
 decided_at timestamptz NOT NULL DEFAULT now(),
 CHECK((acting_for_id IS NULL)=(override_grant_id IS NULL)),
 CHECK(decision<>'return' OR length(btrim(reason))>0)
);
CREATE UNIQUE INDEX cdw_one_final_review_decision ON cdw_review_decisions(gate_id)
 WHERE is_final;
CREATE TABLE cdw_return_orders (
 id text PRIMARY KEY,
 delivery_id text NOT NULL REFERENCES cdw_deliveries(id),
 gate_id text NOT NULL,
 issued_by text NOT NULL REFERENCES users(id),
 assigned_to text NOT NULL REFERENCES users(id),
 reason text NOT NULL CHECK(length(btrim(reason))>0),
 round_no integer NOT NULL CHECK(round_no>=1),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(gate_id,delivery_id,round_no)
  REFERENCES cdw_review_gates(id,delivery_id,round_no)
);

CREATE TABLE cdw_operation_results (
 actor_id text NOT NULL REFERENCES users(id),
 operation text NOT NULL,
 request_key text NOT NULL,
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 http_status integer CHECK(http_status BETWEEN 200 AND 599),
 response jsonb,
 state text NOT NULL CHECK(state IN ('running','done')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_id,operation,request_key),
 CHECK(state <> 'done' OR (http_status IS NOT NULL AND response IS NOT NULL))
);
-- New write commands record immutable domain audit events + outbox in the same transaction.
-- FK and CHECK cannot enforce role qualification, manifest digest, task DAG acyclicity,
-- frozen row immutability or editor callback authority: enforce in serialized commands
-- and permissioned DML, with additional mutation guards before deployment.
