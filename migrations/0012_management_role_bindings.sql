-- P2 management privileges never confer file ACL rights.
CREATE TABLE management_role_bindings (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK(role IN ('auditor', 'permission_admin')),
 scope_kind text NOT NULL CHECK(scope_kind IN ('global', 'folder')),
 scope_id text REFERENCES folders(id),
 allowed_actions text[] NOT NULL DEFAULT '{}'::text[]
   CHECK(allowed_actions <@ ARRAY['list','preview','upload','download','modify','delete','rename','move','print']::text[]),
 expires_at timestamptz,
 granted_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 CHECK ((role='auditor' AND scope_kind='global' AND scope_id IS NULL AND cardinality(allowed_actions)=0)
    OR (role='permission_admin' AND scope_kind='folder' AND scope_id IS NOT NULL AND cardinality(allowed_actions)>0))
);
CREATE INDEX ix_management_roles_active_user ON management_role_bindings(user_id,role) WHERE revoked_at IS NULL;
