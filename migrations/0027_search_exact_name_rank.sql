-- Fast exact-name tier for relevance-ranked search. This is only an
-- accelerator for lower(name)=lower($query), not a change to matching rules.
-- The existing trigram and Han-bigram indexes cover substring matches.
CREATE INDEX ix_files_active_name_lower ON files (lower(name))
 WHERE deleted_at IS NULL;
