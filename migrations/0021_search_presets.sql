CREATE TABLE search_presets (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 48),
 fields jsonb NOT NULL CHECK (jsonb_typeof(fields)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (user_id, name)
);
CREATE INDEX ix_search_presets_user_recent ON search_presets(user_id,updated_at DESC);
