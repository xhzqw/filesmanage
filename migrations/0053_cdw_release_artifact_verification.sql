-- Immutable G8 distribution-format verification for identity DOCX, not a seal.
-- Other conversions/seals MUST come through explicit artifact provenance.
CREATE TABLE cdw_release_artifact_verifications (
 id text PRIMARY KEY,
 release_id text NOT NULL UNIQUE REFERENCES cdw_controlled_releases(id),
 actor_id text NOT NULL REFERENCES users(id),
 role_binding_id text NOT NULL REFERENCES cdw_business_role_bindings(id),
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
 verified_artifact_id text NOT NULL,
 FOREIGN KEY(release_id,verified_artifact_id) REFERENCES cdw_release_artifacts(release_id,id),
 requires_additional_seal boolean NOT NULL,
 requires_conversion boolean NOT NULL,
 justification text NOT NULL CHECK(length(btrim(justification)) BETWEEN 24 AND 3000),
 verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (NOT requires_additional_seal AND NOT requires_conversion)
);
CREATE TRIGGER cdw_release_verification_immutable BEFORE UPDATE OR DELETE ON cdw_release_artifact_verifications
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
