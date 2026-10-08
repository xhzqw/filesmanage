-- Transactional integration test. All fixture records are rolled back.
BEGIN;
INSERT INTO users(id,login,display_name,password_hash)
 VALUES('test_user','test_user','test fixture','unusable');
INSERT INTO folders(id,name,owner_id) VALUES('test_root','temporary root','test_user');
INSERT INTO blobs(id,storage_key,sha256,size_bytes,state)
 VALUES('test_blob_a','test/a',repeat('a',64),1,'ready'),('test_blob_b','test/b',repeat('b',64),1,'ready');
INSERT INTO files(id,folder_id,name,uploaded_by)
 VALUES('test_file','test_root','test.txt','test_user');
INSERT INTO file_versions(id,file_id,seq,blob_id,size_bytes,sha256,action,created_by)
 VALUES('test_v1','test_file',1,'test_blob_a',1,repeat('a',64),'upload','test_user');
UPDATE files SET current_version_seq=1 WHERE id='test_file';
INSERT INTO file_versions(id,file_id,seq,blob_id,size_bytes,sha256,action,created_by,base_seq)
 VALUES('test_v2','test_file',2,'test_blob_b',1,repeat('b',64),'edit','test_user',1);
UPDATE files SET current_version_seq=2 WHERE id='test_file';

DO $test$
DECLARE blocked boolean := false;
BEGIN
  BEGIN
    UPDATE file_versions SET reason='illicit rewrite' WHERE id='test_v1';
  EXCEPTION WHEN check_violation THEN
    blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'immutable historical version modification succeeded'; END IF;
END $test$;

DO $test$
DECLARE blocked boolean := false;
BEGIN
  BEGIN
    DELETE FROM file_versions WHERE id='test_v2';
  EXCEPTION WHEN check_violation THEN
    blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'immutable historical version deletion succeeded'; END IF;
END $test$;

DO $test$
DECLARE blocked boolean := false;
BEGIN
  BEGIN
    UPDATE files SET current_version_seq=1 WHERE id='test_file';
  EXCEPTION WHEN check_violation THEN
    blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'current pointer regression succeeded'; END IF;
END $test$;

INSERT INTO file_versions
 (id,file_id,seq,blob_id,size_bytes,sha256,action,created_by,
  rollback_target_seq,rollback_from_seq,reason)
 VALUES ('test_v3','test_file',3,'test_blob_a',1,repeat('a',64),'rollback','test_user',1,2,'restore source');
UPDATE files SET current_version_seq=3 WHERE id='test_file';

DO $test$
DECLARE n int; current_seq int; actual_checksum char(64);
BEGIN
 SELECT count(*) INTO n FROM file_versions WHERE file_id='test_file';
 IF n<>3 THEN RAISE EXCEPTION 'history count %, expected 3',n; END IF;
 SELECT current_version_seq INTO current_seq FROM files WHERE id='test_file';
 IF current_seq<>3 THEN RAISE EXCEPTION 'current version % is wrong',current_seq; END IF;
 SELECT sha256 INTO actual_checksum FROM file_versions WHERE id='test_v3';
 IF actual_checksum<>repeat('a',64) THEN RAISE EXCEPTION 'rollback did not match target checksum'; END IF;
END $test$;
SELECT 'PASS: append-only version constraints + positive rollback within transaction' AS result;
ROLLBACK;
