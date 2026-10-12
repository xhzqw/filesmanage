-- Access patterns: public invalidations and one account's private events.
-- The original all-events id index alone scans other users' private events.
CREATE INDEX ix_realtime_public_id ON realtime_events(id) WHERE user_id IS NULL;
CREATE INDEX ix_realtime_user_id ON realtime_events(user_id,id) WHERE user_id IS NOT NULL;

-- A durable retention watermark survives complete journal pruning and
-- enables an expired consumer to detect gaps even if the table becomes empty.
-- This is metadata, not a business event or a separate cursor credential.
CREATE TABLE realtime_retention (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 last_pruned_id bigint NOT NULL DEFAULT 0 CHECK(last_pruned_id>=0)
);
INSERT INTO realtime_retention(singleton,last_pruned_id) VALUES(true,0);
