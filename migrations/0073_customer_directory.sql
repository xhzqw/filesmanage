CREATE TABLE customers (
 id text PRIMARY KEY, serial_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 2 AND 200),
 category text NOT NULL CHECK(category IN ('wholesale','retail','mixed','medical','other')),
 credit_code text NOT NULL DEFAULT '' CHECK(length(credit_code)<=32),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 profile jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(profile)='object'),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by text NOT NULL REFERENCES users(id), updated_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customers_credit_code_unique ON customers(upper(credit_code)) WHERE credit_code<>'';
CREATE INDEX customers_category_state ON customers(category,status,id DESC);
CREATE INDEX customers_name_search ON customers(name text_pattern_ops);
CREATE TABLE customer_events (
 id text PRIMARY KEY, customer_id text NOT NULL REFERENCES customers(id),
 revision bigint NOT NULL,
 action text NOT NULL CHECK(action IN ('created','updated','disabled','enabled','registration_submitted','registration_approved','registration_rejected')),
 actor_id text NOT NULL REFERENCES users(id), before_snapshot jsonb, after_snapshot jsonb,
 reason text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_events_history ON customer_events(customer_id,created_at DESC,id DESC);
CREATE TABLE customer_registration_cases (
 id text PRIMARY KEY, customer_id text NOT NULL REFERENCES customers(id),
 snapshot_revision bigint NOT NULL CHECK(snapshot_revision>0),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 requester_id text NOT NULL REFERENCES users(id), reviewer_id text NOT NULL REFERENCES users(id),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), reason text NOT NULL DEFAULT '',
 decided_by text REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz,
 CHECK(requester_id<>reviewer_id), CHECK((state='pending')=(decided_by IS NULL)),
 CHECK((state='pending')=(decided_at IS NULL))
);
CREATE UNIQUE INDEX customer_one_pending_registration ON customer_registration_cases(customer_id) WHERE state='pending';
CREATE INDEX customer_registration_inbox ON customer_registration_cases(reviewer_id,state,created_at DESC);
CREATE INDEX customer_registration_outbox ON customer_registration_cases(requester_id,created_at DESC);
