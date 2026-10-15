-- G6 guard: two valid unrevoked authorizations for one gate/actor would
-- make revoking one grant ineffective. Only one outstanding grant is allowed.
-- A revoked grant is immutable evidence; a fresh grant needs a new ID.
CREATE UNIQUE INDEX cdw_one_nonrevoked_override_per_gate_actor
 ON cdw_override_grants(gate_id,actor_id)
 WHERE gate_id IS NOT NULL AND revoked_at IS NULL;
