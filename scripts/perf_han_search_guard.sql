-- READ-ONLY isolated perf corpus search semantics check. Never run on business DB.
-- A two-Han name occurrence must always be included by the index's necessary
-- bigram predicate; the outer ILIKE then rejects any false positives.
DO $$
DECLARE missing_count integer;
BEGIN
  WITH terms(term) AS (
    VALUES ('导出'),('预算'),('文件'),('边界'),('中文'),('研发'),('市场')
  )
  SELECT count(*) INTO missing_count
    FROM terms CROSS JOIN files f
   WHERE f.deleted_at IS NULL
     AND f.name ILIKE '%' || terms.term || '%'
     AND NOT (fm_search_name_bigrams(f.name) @> ARRAY[terms.term]::text[]);
  IF missing_count <> 0 THEN
    RAISE EXCEPTION 'HAN_BIGRAM_GUARD_FAILED: % false negatives', missing_count;
  END IF;
END
$$;
SELECT 'HAN_BIGRAM_GUARD_PASS';
