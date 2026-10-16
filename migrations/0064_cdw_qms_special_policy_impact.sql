-- A policy pointer change creates a human-review obligation. It does NOT
-- fabricate a new signatory authorization or rewrite existing signatures.
CREATE TABLE cdw_qms_special_policy_impacts (
 id text PRIMARY KEY,
 authority_id text NOT NULL REFERENCES cdw_qms_special_authorities(id),
 subject_file_id text NOT NULL REFERENCES files(id),
 policy_file_id text NOT NULL REFERENCES files(id),
 old_release_id text REFERENCES cdw_controlled_releases(id),
 new_release_id text REFERENCES cdw_controlled_releases(id),
 source_kind text NOT NULL CHECK(source_kind IN('pointer','release_status')),
 event_key text NOT NULL,
 detected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 state text NOT NULL DEFAULT 'open' CHECK(state IN('open','assessed')),
 assessment text CHECK(assessment IS NULL OR length(btrim(assessment))>=16),
 disposition text CHECK(disposition IS NULL OR disposition IN('reapproval_required','no_effect_on_existing_records')),
 assessed_by text REFERENCES users(id),
 assessed_at timestamptz,
 UNIQUE(authority_id,event_key),
 CHECK((state='open' AND assessed_by IS NULL AND assessed_at IS NULL AND assessment IS NULL AND disposition IS NULL)
  OR (state='assessed' AND assessed_by IS NOT NULL AND assessed_at IS NOT NULL
    AND assessment IS NOT NULL AND disposition IS NOT NULL))
);
CREATE INDEX cdw_qms_special_impact_open ON cdw_qms_special_policy_impacts(state,detected_at DESC);
CREATE UNIQUE INDEX cdw_qms_special_one_open_impact
 ON cdw_qms_special_policy_impacts(authority_id,old_release_id) WHERE state='open';
CREATE FUNCTION cdw_qms_special_impact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Special policy impact history is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND (NEW.state<>'open' OR NEW.assessed_at IS NOT NULL) THEN
  RAISE EXCEPTION 'New policy impact must be open' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.state<>'open' OR NEW.state<>'assessed'
   OR NEW.id IS DISTINCT FROM OLD.id OR NEW.authority_id IS DISTINCT FROM OLD.authority_id
   OR NEW.subject_file_id IS DISTINCT FROM OLD.subject_file_id OR NEW.policy_file_id IS DISTINCT FROM OLD.policy_file_id
   OR NEW.old_release_id IS DISTINCT FROM OLD.old_release_id
   OR NEW.new_release_id IS DISTINCT FROM OLD.new_release_id
   OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
   OR NEW.event_key IS DISTINCT FROM OLD.event_key
   OR NEW.detected_at IS DISTINCT FROM OLD.detected_at
   OR NEW.assessed_by IS NULL OR NEW.assessed_at IS NULL
   OR length(btrim(NEW.assessment))<16 OR NEW.disposition IS NULL
   OR NOT EXISTS(
    SELECT 1 FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
    WHERE b.user_id=NEW.assessed_by AND b.role='document_control'
     AND b.user_id<>(SELECT a.proposed_by FROM cdw_qms_special_authorities a WHERE a.id=NEW.authority_id)
     AND (b.file_id=NEW.subject_file_id OR b.file_id IS NULL)
     AND b.department_id IS NULL AND b.revoked_at IS NULL AND u.disabled_at IS NULL
     AND b.valid_from<=clock_timestamp() AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp())
   ) THEN
   RAISE EXCEPTION 'Policy impact requires independent authorized assessment'
    USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_special_impact_guard
 BEFORE INSERT OR UPDATE OR DELETE ON cdw_qms_special_policy_impacts
 FOR EACH ROW EXECUTE FUNCTION cdw_qms_special_impact_guard();

CREATE FUNCTION cdw_qms_special_pointer_impact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.release_id IS NOT DISTINCT FROM OLD.release_id
  AND NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;
 INSERT INTO cdw_qms_special_policy_impacts
 (id,authority_id,subject_file_id,policy_file_id,old_release_id,new_release_id,source_kind,event_key)
 SELECT 'cdwqmsimpact_'||md5(a.id||':pointer:'||NEW.revision::text),
  a.id,a.file_id,NEW.file_id,OLD.release_id,NEW.release_id,'pointer',
  'pointer:'||NEW.revision::text
 FROM cdw_qms_special_authorities a
 JOIN cdw_controlled_releases rel ON rel.id=a.policy_release_id AND rel.file_id=NEW.file_id
 WHERE a.status='verified' AND OLD.release_id=a.policy_release_id
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_special_pointer_impact
 AFTER UPDATE ON cdw_effective_pointers FOR EACH ROW
 EXECUTE FUNCTION cdw_qms_special_pointer_impact();

CREATE FUNCTION cdw_qms_special_release_impact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state IS NOT DISTINCT FROM NEW.state OR OLD.state<>'effective' THEN RETURN NEW; END IF;
 INSERT INTO cdw_qms_special_policy_impacts
 (id,authority_id,subject_file_id,policy_file_id,old_release_id,new_release_id,source_kind,event_key)
 SELECT 'cdwqmsimpact_'||md5(a.id||':release:'||NEW.id||':'||NEW.revision::text),
  a.id,a.file_id,NEW.file_id,OLD.id,
  (SELECT p.release_id FROM cdw_effective_pointers p WHERE p.file_id=NEW.file_id),
  'release_status','release:'||NEW.id||':'||NEW.revision::text
 FROM cdw_qms_special_authorities a
 WHERE a.policy_release_id=NEW.id AND a.status='verified'
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_special_release_impact
 AFTER UPDATE ON cdw_controlled_releases FOR EACH ROW
 EXECUTE FUNCTION cdw_qms_special_release_impact();
