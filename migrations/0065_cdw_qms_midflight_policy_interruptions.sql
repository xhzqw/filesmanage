-- Automatic, irreversible G15 quarantine of in-flight DHF/DMR formal approvals.
-- Never discard already signed decisions; restart as a NEW approval instance.
CREATE TABLE cdw_qms_formal_policy_interruptions (
 id text PRIMARY KEY,
 approval_instance_id text NOT NULL UNIQUE REFERENCES cdw_formal_approval_instances(id),
 authority_id text NOT NULL REFERENCES cdw_qms_special_authorities(id),
 subject_file_id text NOT NULL REFERENCES files(id),
 subject_sha256 text NOT NULL CHECK(subject_sha256 ~ '^[0-9a-f]{64}$'),
 template_version_id text NOT NULL REFERENCES cdw_workflow_template_versions(id),
 old_policy_release_id text NOT NULL REFERENCES cdw_controlled_releases(id),
 replacement_policy_release_id text REFERENCES cdw_controlled_releases(id),
 impact_id text REFERENCES cdw_qms_special_policy_impacts(id),
 cause text NOT NULL CHECK(cause IN('pointer','release_status','authority_revoked')),
 completed_decisions integer NOT NULL CHECK(completed_decisions>=0),
 interrupted_nodes jsonb NOT NULL CHECK(jsonb_typeof(interrupted_nodes)='array'),
 interrupted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_request_id text NOT NULL,
 CHECK(cause<>'authority_revoked' OR impact_id IS NULL)
);
CREATE INDEX cdw_qms_interruption_by_file
 ON cdw_qms_formal_policy_interruptions(subject_file_id,interrupted_at DESC);
CREATE TRIGGER cdw_qms_interruption_immutable BEFORE UPDATE OR DELETE
 ON cdw_qms_formal_policy_interruptions FOR EACH ROW
 EXECUTE FUNCTION cdw_prevent_fact_mutation();

CREATE FUNCTION cdw_qms_interrupt_formal_approvals(
 authority text, reason_kind text, new_policy text, impact text
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
 a record;
 inst record;
 interruption_id text;
 count_affected integer:=0;
 decision_count integer;
 pending_nodes jsonb;
BEGIN
 SELECT * INTO a FROM cdw_qms_special_authorities WHERE id=authority;
 IF NOT FOUND OR reason_kind NOT IN('pointer','release_status','authority_revoked') THEN
  RAISE EXCEPTION 'Invalid dedicated policy interruption source' USING ERRCODE='23514';
 END IF;
 FOR inst IN
  SELECT approval.id,sub.sha256 FROM cdw_formal_approval_instances approval
   JOIN cdw_approval_subjects sub ON sub.id=approval.subject_id
  WHERE approval.state='pending' AND sub.file_id=a.file_id
    AND approval.template_version_id=a.template_version_id
  ORDER BY approval.id FOR UPDATE OF approval
 LOOP
  SELECT count(*) INTO decision_count FROM cdw_formal_approval_decisions decision
    JOIN cdw_formal_approval_steps step ON step.id=decision.step_id
   WHERE step.instance_id=inst.id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
   'nodeKey',step.node_key,'approverId',step.approver_user_id,
   'sequence',step.sequence_no,'state',step.state) ORDER BY step.sequence_no,step.node_key),
   '[]'::jsonb) INTO pending_nodes
   FROM cdw_formal_approval_steps step WHERE step.instance_id=inst.id
    AND step.state IN('ready','waiting');
  interruption_id:='cdwqmsinterruption_'||md5(inst.id);
  INSERT INTO cdw_qms_formal_policy_interruptions
   (id,approval_instance_id,authority_id,subject_file_id,subject_sha256,
    template_version_id,old_policy_release_id,replacement_policy_release_id,
    impact_id,cause,completed_decisions,interrupted_nodes,created_request_id)
  VALUES(interruption_id,inst.id,authority,a.file_id,inst.sha256,
   a.template_version_id,a.policy_release_id,new_policy,impact,reason_kind,
   decision_count,pending_nodes,'system:qms_special:'||interruption_id)
  ON CONFLICT(approval_instance_id) DO NOTHING;
  -- Refuse further signing even if the old policy is later reactivated.
  UPDATE cdw_formal_approval_instances
   SET state='conflicted',completed_at=clock_timestamp(),revision=revision+1
   WHERE id=inst.id AND state='pending';
  UPDATE cdw_formal_approval_steps
   SET state='skipped',revision=revision+1
   WHERE instance_id=inst.id AND state IN('ready','waiting');
  INSERT INTO cdw_domain_events
   (aggregate_kind,aggregate_id,event_kind,actor_id,request_id,details)
  VALUES('formal_approval',inst.id,'qms_policy_interrupted',NULL,
   'system:qms_special:'||interruption_id,
   jsonb_build_object('authorityId',authority,'oldPolicyReleaseId',a.policy_release_id,
    'newPolicyReleaseId',new_policy,'impactId',impact,'cause',reason_kind,
    'interruptionId',interruption_id,'completedDecisions',decision_count));
  count_affected:=count_affected+1;
 END LOOP;
 RETURN count_affected;
END $$;

CREATE FUNCTION cdw_qms_interruption_from_impact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM cdw_qms_interrupt_formal_approvals(
  NEW.authority_id,NEW.source_kind,NEW.new_release_id,NEW.id);
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_interruption_from_impact
 AFTER INSERT ON cdw_qms_special_policy_impacts FOR EACH ROW
 EXECUTE FUNCTION cdw_qms_interruption_from_impact();

-- G14 may coalesce a new change against an already-open impact task. This
-- trigger still terminates any NEW approvals started while an old release
-- was temporarily reactivated, even when no second impact was inserted.
CREATE FUNCTION cdw_qms_interrupt_on_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE authority_row record;
DECLARE related_impact text;
BEGIN
 IF NEW.release_id IS NOT DISTINCT FROM OLD.release_id
  AND NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;
 FOR authority_row IN
  SELECT a.id,a.policy_release_id FROM cdw_qms_special_authorities a
  JOIN cdw_controlled_releases rel ON rel.id=a.policy_release_id
  WHERE a.status='verified' AND rel.file_id=NEW.file_id AND OLD.release_id=a.policy_release_id
 LOOP
  SELECT i.id INTO related_impact FROM cdw_qms_special_policy_impacts i
  WHERE i.authority_id=authority_row.id AND i.old_release_id=authority_row.policy_release_id
  ORDER BY i.detected_at DESC,i.id DESC LIMIT 1;
  PERFORM cdw_qms_interrupt_formal_approvals(authority_row.id,'pointer',NEW.release_id,related_impact);
 END LOOP;
 RETURN NEW;
END $$;
-- Alphabetical order ensures this runs after G14's 'special_pointer_impact'.
CREATE TRIGGER cdw_qms_z_interrupt_on_pointer
 AFTER UPDATE ON cdw_effective_pointers FOR EACH ROW
 EXECUTE FUNCTION cdw_qms_interrupt_on_pointer();

CREATE FUNCTION cdw_qms_interruption_from_revoke() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='verified' AND NEW.status='revoked' THEN
  PERFORM cdw_qms_interrupt_formal_approvals(NEW.id,'authority_revoked',NULL,NULL);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_interruption_from_revoke
 AFTER UPDATE ON cdw_qms_special_authorities FOR EACH ROW
 EXECUTE FUNCTION cdw_qms_interruption_from_revoke();

CREATE FUNCTION cdw_qms_interruption_no_resurrection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='conflicted'
  AND EXISTS(SELECT 1 FROM cdw_qms_formal_policy_interruptions h
  WHERE h.approval_instance_id=OLD.id)
   AND (NEW.state<>'conflicted' OR NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
  RAISE EXCEPTION 'Interrupted formal approval must restart as new instance' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_interruption_no_resurrection BEFORE UPDATE
 ON cdw_formal_approval_instances FOR EACH ROW EXECUTE FUNCTION cdw_qms_interruption_no_resurrection();

CREATE FUNCTION cdw_qms_interruption_no_forged_decisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM cdw_formal_approval_steps s
  JOIN cdw_qms_formal_policy_interruptions h ON h.approval_instance_id=s.instance_id
  WHERE s.id=NEW.step_id) THEN
  RAISE EXCEPTION 'Interrupted approval cannot be signed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_interruption_no_forged_decisions BEFORE INSERT
 ON cdw_formal_approval_decisions FOR EACH ROW
 EXECUTE FUNCTION cdw_qms_interruption_no_forged_decisions();

CREATE FUNCTION cdw_qms_interruption_no_candidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM cdw_qms_formal_policy_interruptions
  WHERE approval_instance_id=NEW.approval_instance_id) THEN
  RAISE EXCEPTION 'Interrupted approval cannot produce a candidate' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_interruption_no_candidate BEFORE INSERT
 ON cdw_approved_candidates FOR EACH ROW EXECUTE FUNCTION cdw_qms_interruption_no_candidate();
