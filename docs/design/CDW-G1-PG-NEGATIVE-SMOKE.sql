-- CDW G1: non-destructive PostgreSQL 17 draft constraint smoke.
-- RUN ONLY inside a transaction in an independently isolated empty validation DB,
-- AFTER all base migrations and CDW G1 DDL-01, DDL-02. Outer caller ROLLBACKs.
-- This is a representative negative smoke, NOT DB-01..DB-26 completion.
INSERT INTO users(id,login,display_name,password_hash)
 VALUES ('cdw_u1','cdw_g1_u1','CDW Gate U1','not-a-login'),
        ('cdw_u2','cdw_g1_u2','CDW Gate U2','not-a-login');
INSERT INTO departments(id,name) VALUES ('cdw_d1','CDW Gate D1'),('cdw_d2','CDW Gate D2');
INSERT INTO folders(id,name,owner_id) VALUES ('cdw_folder','CDW Gate','cdw_u1');
INSERT INTO files(id,folder_id,name,uploaded_by)
 VALUES ('cdw_f1','cdw_folder','file1.docx','cdw_u1'),('cdw_f2','cdw_folder','file2.docx','cdw_u1');
INSERT INTO blobs(id,storage_key,sha256,size_bytes,state)
 VALUES ('cdw_blob1','cdw-g1-gate-blob1',repeat('a',64),10,'ready'),
        ('cdw_blob2','cdw-g1-gate-blob2',repeat('b',64),20,'ready');
INSERT INTO file_versions(id,file_id,seq,blob_id,size_bytes,sha256,action,created_by)
 VALUES ('cdw_v1','cdw_f1',1,'cdw_blob1',10,repeat('a',64),'upload','cdw_u1'),
        ('cdw_v2','cdw_f2',1,'cdw_blob2',20,repeat('b',64),'upload','cdw_u1');
UPDATE files SET current_version_seq=1 WHERE id IN ('cdw_f1','cdw_f2');
INSERT INTO cdw_workflow_template_versions
 (id,template_key,version_no,lifecycle,graph,role_policy,created_by)
 VALUES ('cdw_tpl','cdw_smoke',1,'draft','{}','{}','cdw_u1');
INSERT INTO cdw_tasks(id,root_id,template_version_id,title,subject_kind,file_id,state,created_by)
 VALUES ('cdw_task','cdw_task','cdw_tpl','Smoke task','file','cdw_f1','draft','cdw_u1');

INSERT INTO workgroups(id,name) VALUES ('cdw_group','CDW Gate Group');
INSERT INTO cdw_task_assignments(id,task_id,assigned_by,user_id,kind)
 VALUES ('cdw_assign1','cdw_task','cdw_u1','cdw_u2','primary');
DO $$
BEGIN
 BEGIN
  INSERT INTO cdw_task_assignments(id,task_id,assigned_by,user_id,kind)
   VALUES ('cdw_assign_dup','cdw_task','cdw_u1','cdw_u1','primary');
  RAISE EXCEPTION 'G1 FAIL: duplicate primary assignment accepted';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO cdw_task_assignments(id,task_id,assigned_by,user_id,group_id,kind)
   VALUES ('cdw_assign_xor','cdw_task','cdw_u1','cdw_u2','cdw_group','support');
  RAISE EXCEPTION 'G1 FAIL: both target types accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $$;

INSERT INTO cdw_task_manifest_versions
 (id,root_task_id,version_no,manifest_sha256,frozen_by)
 VALUES ('cdw_manifest','cdw_task',1,repeat('a',64),'cdw_u1');
DO $$
BEGIN
 BEGIN
  INSERT INTO cdw_task_manifest_items
  (manifest_version_id,ordinal,file_id,base_version_id,base_sha256,path_snapshot)
  VALUES ('cdw_manifest',1,'cdw_f1','cdw_v2',repeat('b',64),'bad path');
  RAISE EXCEPTION 'G1 FAIL: cross-file baseline accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
END $$;

INSERT INTO cdw_work_branches(id,task_id,file_id,base_version_id,base_sha256,state,created_by)
 VALUES ('cdw_branch','cdw_task','cdw_f1','cdw_v1',repeat('a',64),'open','cdw_u1');
INSERT INTO cdw_work_branch_revisions(id,branch_id,ordinal,blob_id,sha256,size_bytes,save_epoch)
 VALUES ('cdw_branch_rev1','cdw_branch',1,'cdw_blob1',repeat('a',64),10,1);
DO $$
DECLARE message text;
BEGIN
 BEGIN
  UPDATE cdw_work_branch_revisions SET size_bytes=11 WHERE id='cdw_branch_rev1';
  RAISE EXCEPTION 'G1 FAIL: append-only branch revision updated';
 EXCEPTION WHEN check_violation THEN
  GET STACKED DIAGNOSTICS message = MESSAGE_TEXT;
  IF message <> 'CDW evidence is append-only' THEN RAISE; END IF;
 END;
END $$;

INSERT INTO cdw_approval_subjects
 (id,file_id,source_kind,base_version_id,blob_id,sha256,size_bytes,frozen_by)
 VALUES ('cdw_subject','cdw_f1','existing_version','cdw_v1','cdw_blob1',repeat('a',64),10,'cdw_u1');
INSERT INTO cdw_formal_approval_instances
 (id,subject_id,template_version_id,state,requested_by,completed_at)
 VALUES ('cdw_instance','cdw_subject','cdw_tpl','approved','cdw_u1',now());
INSERT INTO cdw_approved_candidates
 (id,subject_id,file_id,approval_instance_id,content_sha256)
 VALUES ('cdw_candidate','cdw_subject','cdw_f1','cdw_instance',repeat('a',64));
INSERT INTO cdw_controlled_releases
 (id,file_id,approved_candidate_id,controlled_revision,display_name_snapshot,state,policy_snapshot,prepared_by)
 VALUES ('cdw_release','cdw_f1','cdw_candidate','A/1','file1.docx','preparing','{}','cdw_u1');
INSERT INTO cdw_release_artifacts
 (id,release_id,format,purpose,blob_id,sha256,size_bytes,created_by)
 VALUES ('cdw_artifact','cdw_release','docx','distribution','cdw_blob1',repeat('a',64),10,'cdw_u1');

INSERT INTO cdw_distribution_plans(id,state,created_by) VALUES ('cdw_plan','draft','cdw_u1');
INSERT INTO cdw_distribution_plan_items
 (plan_id,ordinal,release_id,artifact_id,artifact_sha256)
 VALUES ('cdw_plan',1,'cdw_release','cdw_artifact',repeat('a',64));
INSERT INTO cdw_distribution_plan_targets
 (plan_id,department_id,designated_receiver_id,channel,paper_quantity)
 VALUES ('cdw_plan','cdw_d1','cdw_u2','electronic',0);
INSERT INTO cdw_distribution_plan_target_requirements
 (plan_id,department_id,item_ordinal,receipt_required,reading_required)
 VALUES ('cdw_plan','cdw_d1',1,true,false);
UPDATE cdw_distribution_plans
 SET state='frozen',digest_sha256=repeat('c',64),frozen_at=now(),revision=2 WHERE id='cdw_plan';

DO $$
DECLARE message text;
BEGIN
 BEGIN
  UPDATE cdw_distribution_plan_target_requirements SET reading_required=true
  WHERE plan_id='cdw_plan' AND department_id='cdw_d1';
  RAISE EXCEPTION 'G1 FAIL: approved per-department requirement rewritten';
 EXCEPTION WHEN raise_exception THEN
  GET STACKED DIAGNOSTICS message = MESSAGE_TEXT;
  IF message <> 'distribution plan or batch items are frozen' THEN RAISE; END IF;
 END;
END $$;

INSERT INTO cdw_distribution_batches(id,plan_id,plan_digest_sha256,state)
 VALUES ('cdw_batch','cdw_plan',repeat('c',64),'draft');
-- Regression: choosing plan_id rather than batch_id as parent lock would
-- incorrectly reject these *valid* inserts.
INSERT INTO cdw_distribution_batch_items
 (id,batch_id,plan_id,ordinal,release_id,artifact_id,artifact_sha256)
 VALUES ('cdw_batch_item','cdw_batch','cdw_plan',1,'cdw_release','cdw_artifact',repeat('a',64));
INSERT INTO cdw_distribution_targets
 (id,batch_id,plan_id,department_id,designated_receiver_id)
 VALUES ('cdw_target','cdw_batch','cdw_plan','cdw_d1','cdw_u2');
INSERT INTO cdw_target_item_requirements
 (target_id,batch_id,plan_id,department_id,batch_item_id,item_ordinal,receipt_required,reading_required)
 VALUES ('cdw_target','cdw_batch','cdw_plan','cdw_d1','cdw_batch_item',1,true,false);

DO $$
BEGIN
 BEGIN
  UPDATE cdw_target_item_requirements SET reading_required=true
   WHERE target_id='cdw_target' AND batch_item_id='cdw_batch_item';
  RAISE EXCEPTION 'G1 FAIL: unapproved reading requirement accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
END $$;
UPDATE cdw_distribution_batches SET state='frozen',revision=2 WHERE id='cdw_batch';
DO $$
DECLARE message text;
BEGIN
 BEGIN
  UPDATE cdw_target_item_requirements SET implementation_required=true WHERE target_id='cdw_target';
  RAISE EXCEPTION 'G1 FAIL: frozen batch requirements rewritten';
 EXCEPTION WHEN raise_exception THEN
  GET STACKED DIAGNOSTICS message = MESSAGE_TEXT;
  IF message <> 'distribution plan or batch items are frozen' THEN RAISE; END IF;
 END;
END $$;
SELECT 'CDW_G1_PG_NEGATIVE_SMOKE_PASS' AS result;
