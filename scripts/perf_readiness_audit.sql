-- Read-only, SPEC §24.2 dataset readiness audit. Target: dedicated filesmanage_perf.
-- This script must never create, update, or delete business or test records.
-- It reports the distribution gates required before PE01–PE18 performance claims.
\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

WITH RECURSIVE
folder_depth AS (
  SELECT id,parent_id,1::bigint AS depth FROM folders WHERE parent_id IS NULL
  UNION ALL
  SELECT f.id,f.parent_id,d.depth+1
    FROM folders f JOIN folder_depth d ON f.parent_id=d.id
    WHERE d.depth < 256
),
folder_file_counts AS (
  SELECT folder_id,count(*)::bigint AS n FROM files GROUP BY folder_id
),
version_counts AS (
  SELECT file_id,count(*)::bigint AS n FROM file_versions GROUP BY file_id
),
actual AS (
  SELECT
    (SELECT count(*) FROM folders)::bigint AS folders,
    (SELECT count(*) FROM files)::bigint AS files,
    (SELECT count(*) FROM file_versions)::bigint AS versions,
    (SELECT count(*) FROM users)::bigint AS users,
    (SELECT count(*) FROM acls)::bigint AS acls,
    (SELECT count(*) FROM file_text)::bigint AS indexed_text,
    (SELECT count(*) FROM shares)::bigint AS shares,
    (SELECT count(*) FROM favorites)::bigint AS favorites,
    (SELECT coalesce(max(n),0) FROM folder_file_counts)::bigint AS hot_folder_files,
    (SELECT count(*) FROM folder_file_counts WHERE n BETWEEN 45 AND 55)::bigint AS near_50_file_folders,
    (SELECT coalesce(max(depth),0) FROM folder_depth)::bigint AS max_folder_depth,
    (SELECT coalesce(max(n),0) FROM version_counts)::bigint AS max_versions_per_file
),
gates AS (
  SELECT name, observed, minimum FROM actual,
  LATERAL (VALUES
    ('folders',folders,10000::bigint),
    ('files',files,100000::bigint),
    ('versions',versions,400000::bigint),
    ('users',users,1000::bigint),
    ('ACLs',acls,50000::bigint),
    ('text_indexed_files',indexed_text,50000::bigint),
    ('shares',shares,20000::bigint),
    ('favorites',favorites,100000::bigint),
    ('max_files_in_one_hot_folder',hot_folder_files,5000::bigint),
    ('ordinary_folders_45_to_55_files',near_50_file_folders,1::bigint),
    ('folder_max_depth',max_folder_depth,21::bigint),
    ('max_versions_on_one_file',max_versions_per_file,1000::bigint)
  ) AS t(name,observed,minimum)
)
SELECT name AS perf_gate, observed, minimum,
       CASE WHEN observed>=minimum THEN 'PASS' ELSE 'FAIL' END AS outcome
FROM gates ORDER BY name;

COMMIT;
