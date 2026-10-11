-- Unicode Han 2-character substring accelerator for exact name containment.
-- pg_trgm does not provide an effective indexed predicate for ILIKE '%导出%':
-- the search substring contains no extractable three-character trigram.
-- Keep the original ILIKE as authoritative; this immutable GIN prefilter only
-- reduces the candidate set for EXACT two-Han-character search terms.
--
-- The expression index is maintained transactionally on INSERT/UPDATE/DELETE;
-- no asynchronous search service and no additional table to backfill.
CREATE FUNCTION fm_search_name_bigrams(input text) RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
 SELECT COALESCE(array_agg(DISTINCT substring(input from pos for 2)), ARRAY[]::text[])
 FROM generate_series(1, char_length(input) - 1) AS pos
$$;
CREATE INDEX ix_files_active_name_bigrams
 ON files USING gin (fm_search_name_bigrams(name))
 WHERE deleted_at IS NULL;
