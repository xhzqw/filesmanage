-- Performance dataset generator (SPEC §24.2 / PERF-DATA-01/02/04).
--
-- Target: the dedicated scratch database filesmanage_perf ONLY. The business
-- database filesmanage_v21, the legacy Node/SQLite stores and port 8091 are
-- never touched. Re-running requires a fresh scratch database (the guard below
-- refuses any database that already holds files).
--
-- Usage (on the target host, as root):
--   sudo -u postgres dropdb --if-exists filesmanage_perf
--   sudo -u postgres createdb -O filesmanage_v21 filesmanage_perf
--   DATABASE_URL=postgres://filesmanage_v21:<pw>@127.0.0.1:5432/filesmanage_perf?sslmode=disable \
--     go run ./cmd/migrate -dir migrations
--   sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d filesmanage_perf -f scripts/perf_dataset.sql
--
-- SPEC §24.2 reference scale and the distribution gates checked by
-- scripts/perf_readiness_audit.py:
--   folders >= 10,000 (root + 20-deep chain + hot + 350 ordinary + 9,627 bulk)
--   files   >= 100,000 (deep 60 + hot 5,000 + ordinary 17,500 + high-version 1
--                        + bulk 77,831 = 100,392)
--   versions >= 400,000 (4 per regular file + 1,000 on one hot file = 402,564)
--   users   >= 1,000 (1 admin + 1,000 load users in two workgroups)
--   ACLs    >= 50,000 (group grant on every folder + user grants; ~10% expired,
--                      ~25% scope_only so inheritance/expiry paths are exercised)
--   text    >= 50,000 indexed files (all files indexed, CJK spaced content)
--   shares  >= 20,000 (12,000 file + 8,000 folder; expired/revoked mix)
--   favorites >= 100,000 (80,000 file + 20,000 folder, per-user unique)
--   one hot folder with >= 5,000 files; 350 ordinary folders with exactly 50
--   files; folder depth 21 (root counted); one file with 1,000 versions.
--
-- The perf load-user password is a scratch-only credential for the isolated
-- perf database; the bcrypt hash below matches "Perf-Load-2026!only".

\set ON_ERROR_STOP on

-- Fail-closed guard: scratch database only, migrations applied, empty.
DO $$
BEGIN
  IF current_database() <> 'filesmanage_perf' THEN
    RAISE EXCEPTION 'refusing to run: current database is %, expected filesmanage_perf', current_database();
  END IF;
  IF to_regclass('public.files') IS NULL OR to_regclass('public.shares') IS NULL THEN
    RAISE EXCEPTION 'schema not present; run the migrations first';
  END IF;
  PERFORM 1 FROM files LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'refusing to seed: database already contains files';
  END IF;
END
$$;

\echo 'seeding principals'

-- Admin actor for the generated tree (owner of folders, uploader of files).
INSERT INTO users(id,login,display_name,password_hash,is_admin,must_change_password)
VALUES ('u_perf','perf-admin','压测管理员',
        '$2a$10$wK8WszVjQN.yq.VoKX2A2O19QVtGMgK6JNrmGhBFCfuU3y.Jb4SxK',true,false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO departments(id,name) VALUES ('dept_perf','压测部门') ON CONFLICT (id) DO NOTHING;
INSERT INTO workgroups(id,department_id,name)
VALUES ('group_perf','dept_perf','压测工作组') ON CONFLICT (id) DO NOTHING;
INSERT INTO workgroups(id,department_id,name)
VALUES ('group_perf_half','dept_perf','压测半席工作组') ON CONFLICT (id) DO NOTHING;

INSERT INTO users(id,login,display_name,password_hash,is_admin,must_change_password,department_id)
SELECT 'pu_'||n,'perf-'||n,'压测用户 '||n,
       '$2a$10$wK8WszVjQN.yq.VoKX2A2O19QVtGMgK6JNrmGhBFCfuU3y.Jb4SxK',false,false,'dept_perf'
FROM generate_series(1,1000) n
ON CONFLICT (id) DO NOTHING;

INSERT INTO workgroup_members(group_id,user_id)
SELECT 'group_perf','pu_'||n FROM generate_series(1,1000) n ON CONFLICT DO NOTHING;
INSERT INTO workgroup_members(group_id,user_id)
SELECT 'group_perf_half','pu_'||n FROM generate_series(1,500) n ON CONFLICT DO NOTHING;

\echo 'seeding folder tree'

INSERT INTO folders(id,parent_id,name,owner_id,created_by)
VALUES ('pf_root',NULL,'压测根目录','u_perf','u_perf');

-- Deep chain (21 levels counting the root; SPEC PERF-DATA-02 >= 20 edges).
WITH RECURSIVE chain(n,id,parent_id) AS (
  SELECT 1,'pd_01','pf_root'
  UNION ALL
  SELECT n+1,'pd_'||lpad((n+1)::text,2,'0'),'pd_'||lpad(n::text,2,'0')
  FROM chain WHERE n < 20
)
INSERT INTO folders(id,parent_id,name,owner_id,created_by)
SELECT id,parent_id,'深层目录 '||n,'u_perf','u_perf' FROM chain;

INSERT INTO folders(id,parent_id,name,owner_id,created_by)
VALUES ('pf_hot','pf_root','热点大目录','u_perf','u_perf');

INSERT INTO folders(id,parent_id,name,owner_id,created_by)
VALUES ('pf_hv_dir','pf_root','千版本文件目录','u_perf','u_perf');

-- Ordinary folders: exactly 50 files each (SPEC gate 45-55).
INSERT INTO folders(id,parent_id,name,owner_id,created_by)
SELECT 'pf_ord_'||lpad(n::text,3,'0'),'pf_root','普通目录 '||n,'u_perf','u_perf'
FROM generate_series(1,350) n;

-- Bulk siblings under the root (wide tree for list/scope paging).
INSERT INTO folders(id,parent_id,name,owner_id,created_by)
SELECT 'pf_bulk_'||lpad(n::text,4,'0'),'pf_root','目录 '||n,'u_perf','u_perf'
FROM generate_series(1,9627) n;

\echo 'seeding files'

-- One row per file with its version count; temp table keeps the cross joins
-- below readable. Expected total: 100,392 files.
CREATE TEMP TABLE perf_files AS
  SELECT 'pf_deep_'||f.id||'_'||n AS id, f.id AS folder_id,
         '文件 '||f.id||'-'||n||'.txt' AS name, 4 AS nver
  FROM folders f CROSS JOIN generate_series(1,3) n
  WHERE f.id LIKE 'pd_%'
  UNION ALL
  SELECT 'pf_hot_'||n, 'pf_hot', '文件 pf_hot-'||n||'.txt', 4
  FROM generate_series(1,5000) n
  UNION ALL
  SELECT 'pf_ord_'||f.id||'_'||n, f.id, '文件 '||f.id||'-'||n||'.txt', 4
  FROM folders f CROSS JOIN generate_series(1,50) n
  WHERE f.id LIKE 'pf_ord_%'
  UNION ALL
  SELECT 'pf_highver','pf_hv_dir','千版本文件.txt',1000
  UNION ALL
  SELECT 'pf_bulk_'||f.id||'_'||n, f.id, '文件 '||f.id||'-'||n||'.txt', 4
  FROM folders f CROSS JOIN generate_series(1,8) n
  WHERE f.id LIKE 'pf_bulk_%'
  UNION ALL
  SELECT 'pf_bulk_'||f.id||'_9', f.id, '文件 '||f.id||'-9.txt', 4
  FROM folders f
  WHERE f.id LIKE 'pf_bulk_%' AND f.id <= 'pf_bulk_0815';

-- SPEC §12.2 export edge cases: formula-leading names, commas, quotes and an
-- emoji name, so CSV escaping and formula neutralisation are exercised.
INSERT INTO folders(id,parent_id,name,owner_id,created_by)
VALUES ('pf_edge','pf_root','导出边界样例','u_perf','u_perf');

INSERT INTO files(id,folder_id,name,uploaded_by,content_type,current_version_seq)
SELECT 'pf_edge_'||row_number() OVER (),'pf_edge',n,'u_perf','text/plain',NULL
FROM (VALUES
  ('=cmd|'' /C calc''!A0.txt'),
  ('+1.txt'),('-2.txt'),('@SUM(A1:A9).txt'),
  ('中文,逗号.txt'),('say"hi".txt'),('tab\there.txt'),
  ('emoji-🚀-预算.txt'),('space name .txt'),
  ('=HYPERLINK("http://x")!.txt')
) AS t(n)
CROSS JOIN generate_series(1,1) g;

INSERT INTO blobs(id,storage_key,sha256,size_bytes,state)
SELECT 'pbe_'||id, 'ready/'||substr(encode(sha256(('edge'||id)::bytea),'hex'),1,2)||'/'||encode(sha256(('edge'||id)::bytea),'hex'),
       encode(sha256(('edge'||id)::bytea),'hex'), length('edge'||id), 'ready'
FROM files WHERE folder_id='pf_edge' ON CONFLICT (id) DO NOTHING;

INSERT INTO file_versions(id,file_id,seq,blob_id,size_bytes,sha256,action,base_seq,created_by)
SELECT 'pfev_'||f.id, f.id, 1, 'pbe_'||f.id, length('edge'||f.id), encode(sha256(('edge'||f.id)::bytea),'hex'),
       'upload', NULL, 'u_perf'
FROM files f WHERE f.folder_id='pf_edge' ON CONFLICT (file_id,seq) DO NOTHING;

UPDATE files f SET current_version_seq=v.seq
FROM (SELECT file_id,max(seq) AS seq FROM file_versions GROUP BY file_id) v
WHERE f.id=v.file_id AND f.current_version_seq IS DISTINCT FROM v.seq AND f.folder_id='pf_edge';

INSERT INTO file_text(file_id,current_seq,content,spaced)
SELECT f.id,1,'导出边界样例 '||f.name,
       regexp_replace('导出边界样例 '||f.name, E'([\u4e00-\u9fff])', E' \\1 ', 'g')
FROM files f WHERE f.folder_id='pf_edge' ON CONFLICT (file_id) DO NOTHING;

\echo 'seeding blobs'

-- One immutable ready blob per version; content is the literal seed string so
-- the digest is reproducible without materialising media on disk.
INSERT INTO blobs(id,storage_key,sha256,size_bytes,state)
SELECT 'pbv_'||src.id||'_'||s,
       'ready/'||substr(encode(sha256(('perf'||src.id||s)::bytea),'hex'),1,2)
              ||'/'||encode(sha256(('perf'||src.id||s)::bytea),'hex'),
       encode(sha256(('perf'||src.id||s)::bytea),'hex'),
       length('perf'||src.id||s),
       'ready'
FROM perf_files src CROSS JOIN generate_series(1,src.nver) s
ON CONFLICT (id) DO NOTHING;

\echo 'seeding files (pointer deferred)'

INSERT INTO files(id,folder_id,name,uploaded_by,content_type,current_version_seq)
SELECT id,folder_id,name,'u_perf','text/plain',NULL FROM perf_files
ON CONFLICT (id) DO NOTHING;

\echo 'seeding versions'

INSERT INTO file_versions(id,file_id,seq,blob_id,size_bytes,sha256,action,base_seq,created_by)
SELECT 'pfv_'||src.id||'_'||s,
       src.id,
       s,
       'pbv_'||src.id||'_'||s,
       length('perf'||src.id||s),
       encode(sha256(('perf'||src.id||s)::bytea),'hex'),
       CASE WHEN s=1 THEN 'upload' ELSE 'edit' END,
       CASE WHEN s=1 THEN NULL ELSE s-1 END,
       'u_perf'
FROM perf_files src CROSS JOIN generate_series(1,src.nver) s
ON CONFLICT (file_id,seq) DO NOTHING;

\echo 'seeding text index'

-- spaced inserts a space around every CJK character (SPEC §10.2) so
-- PostgreSQL's simple configuration tokenises them and phraseto_tsquery keeps
-- phrase adjacency when searching Chinese content.
INSERT INTO file_text(file_id,current_seq,content,spaced)
SELECT id,nver,
       '压测文件内容 '||name||' '||CASE WHEN abs(hashtext(id)) % 5 = 0
              THEN '设备验收报告 装配测试' ELSE '预算 年度预算 项目' END,
       regexp_replace('压测文件内容 '||name||' '||CASE WHEN abs(hashtext(id)) % 5 = 0
              THEN '设备验收报告 装配测试' ELSE '预算 年度预算 项目' END,
                      E'([\u4e00-\u9fff])', E' \\1 ', 'g')
FROM perf_files
ON CONFLICT (file_id) DO NOTHING;

-- Raise the current-version pointer now that every version exists.
UPDATE files f SET current_version_seq=v.seq
FROM (SELECT file_id,max(seq) AS seq FROM file_versions GROUP BY file_id) v
WHERE f.id=v.file_id AND f.current_version_seq IS DISTINCT FROM v.seq;

\echo 'seeding ACLs'

-- Group grant on every folder: baseline inheritance for all 1,000 users.
INSERT INTO acls(id,folder_id,subject_kind,subject_id,actions,scope_only,granted_by)
SELECT 'pag_'||f.id, f.id, 'group', 'group_perf', ARRAY['list','preview'], false, 'u_perf'
FROM folders f ON CONFLICT (id) DO NOTHING;

-- User grants on bulk folders: 4 per folder; ~25% scope_only, ~10% expired.
INSERT INTO acls(id,folder_id,subject_kind,subject_id,actions,scope_only,expires_at,granted_by)
SELECT 'pa_'||f.id||'_'||n, f.id, 'user',
       'pu_'||((abs(hashtext(f.id||n)) % 1000) + 1),
       ARRAY['list','preview','download'],
       (abs(hashtext(f.id||n)) % 4 = 0),
       CASE WHEN abs(hashtext(f.id||n)) % 10 = 0 THEN now() - interval '1 day' ELSE NULL END,
       'u_perf'
FROM folders f CROSS JOIN generate_series(1,4) n
WHERE f.id LIKE 'pf_bulk_%'
ON CONFLICT (id) DO NOTHING;

-- User grants on ordinary folders (5 each, mixed scope/expiry).
INSERT INTO acls(id,folder_id,subject_kind,subject_id,actions,scope_only,expires_at,granted_by)
SELECT 'pao_'||f.id||'_'||n, f.id, 'user',
       'pu_'||((abs(hashtext(f.id||n)) % 1000) + 1),
       ARRAY['list','preview','upload'],
       (abs(hashtext(f.id||n)) % 3 = 0),
       CASE WHEN abs(hashtext(f.id||n)) % 12 = 0 THEN now() - interval '6 hours' ELSE NULL END,
       'u_perf'
FROM folders f CROSS JOIN generate_series(1,5) n
WHERE f.id LIKE 'pf_ord_%'
ON CONFLICT (id) DO NOTHING;

-- Hot folder, deep chain and high-version folder grants.
INSERT INTO acls(id,folder_id,subject_kind,subject_id,actions,scope_only,granted_by)
SELECT 'pah_'||n, 'pf_hot', 'user', 'pu_'||n, ARRAY['list','preview','upload','download'], false, 'u_perf'
FROM generate_series(1,5) n ON CONFLICT (id) DO NOTHING;

INSERT INTO acls(id,folder_id,subject_kind,subject_id,actions,scope_only,granted_by)
SELECT 'pad_'||f.id||'_'||n, f.id, 'user',
       'pu_'||((abs(hashtext(f.id||n)) % 1000) + 1),
       ARRAY['list','preview'],
       true,
       'u_perf'
FROM folders f CROSS JOIN generate_series(1,2) n
WHERE f.id LIKE 'pd_%' OR f.id = 'pf_hv_dir'
ON CONFLICT (id) DO NOTHING;

\echo 'seeding shares'

-- File shares to individual users (25% expired, 10% revoked).
INSERT INTO shares(id,file_id,folder_id,recipient_kind,recipient_id,actions,
                   include_descendants,expires_at,revoked_at,created_by)
SELECT 'ps_'||n, f.id, NULL, 'user', 'pu_'||((n % 1000) + 1),
       ARRAY['preview','download'], false,
       CASE WHEN n % 4 = 0 THEN now() - interval '2 days' ELSE NULL END,
       CASE WHEN n % 10 = 0 THEN now() - interval '1 day' ELSE NULL END,
       'u_perf'
FROM (SELECT id,row_number() OVER (ORDER BY id) AS n FROM files) f
WHERE n <= 12000;

-- Folder shares to the workgroup (half with descendants; 20% expired, 10% revoked).
INSERT INTO shares(id,file_id,folder_id,recipient_kind,recipient_id,actions,
                   include_descendants,expires_at,revoked_at,created_by)
SELECT 'psf_'||n, NULL, f.id, 'group', 'group_perf',
       ARRAY['list','preview'], (n % 2 = 0),
       CASE WHEN n % 5 = 0 THEN now() - interval '3 days' ELSE NULL END,
       CASE WHEN n % 10 = 0 THEN now() - interval '1 day' ELSE NULL END,
       'u_perf'
FROM (SELECT id,row_number() OVER (ORDER BY id) AS n FROM folders) f
WHERE n <= 8000;

\echo 'seeding favorites'

INSERT INTO favorites(id,user_id,file_id,folder_id)
SELECT 'pfa_'||n, 'pu_'||(((n - 1) % 1000) + 1), f.id, NULL
FROM (SELECT id,row_number() OVER (ORDER BY id) AS n FROM files) f
WHERE n <= 90000;

INSERT INTO favorites(id,user_id,file_id,folder_id)
SELECT 'pfb_'||n, 'pu_'||(((n - 1) % 1000) + 1), NULL, f.id
FROM (SELECT id,row_number() OVER (ORDER BY id) AS n FROM folders) f
WHERE n <= 20000;

ANALYZE;

SELECT 'folders='||(SELECT count(*) FROM folders)
     ||' users='||(SELECT count(*) FROM users)
     ||' files='||(SELECT count(*) FROM files)
     ||' versions='||(SELECT count(*) FROM file_versions)
     ||' blobs='||(SELECT count(*) FROM blobs)
     ||' acls='||(SELECT count(*) FROM acls)
     ||' text='||(SELECT count(*) FROM file_text)
     ||' shares='||(SELECT count(*) FROM shares)
     ||' favorites='||(SELECT count(*) FROM favorites) AS perf_dataset_summary;
