#!/usr/bin/env python3
"""Non-destructive restore drill for the isolated filesmanage v2.1 PostgreSQL + blob store.

Run only on 192.168.1.22 from the project root with DATABASE_URL exported.
Does not connect to or modify the legacy database, ERP databases, or file storage.
Never drops a database unless this process created it with the guarded prefix.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_DB = "filesmanage_v21"
RESTORE_PREFIX = "filesmanage_restore_drill_v21_"
REQUIRED_TABLES = ("users", "departments", "folders", "files", "file_versions", "blobs", "schema_migrations")


def fail(message):
    raise RuntimeError(message)


def execute(argv, *, env=None, capture=False):
    result = subprocess.run(argv, env=env, text=True, capture_output=True)
    if result.returncode:
        message = (result.stderr or result.stdout or "command failed").strip()[-500:]
        fail(f"{argv[0]} failed (exit {result.returncode}): {message}")
    return result.stdout if capture else ""


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_identifier(value):
    if not re.fullmatch(r"[a-z][a-z0-9_]*", value):
        fail("unsafe PostgreSQL identifier")
    return value


def pg_env(uri):
    parsed = urlsplit(uri)
    if parsed.scheme not in ("postgresql", "postgres") or unquote(parsed.path.removeprefix("/")) != EXPECTED_DB:
        fail("refusing backup: DATABASE_URL must identify exact isolated filesmanage_v21 database")
    if parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        fail("refusing backup: database host must be localhost")
    env = os.environ.copy()
    env["PGHOST"] = parsed.hostname
    env["PGPORT"] = str(parsed.port or 5432)
    env["PGUSER"] = unquote(parsed.username or "")
    env["PGPASSWORD"] = unquote(parsed.password or "")
    env["PGDATABASE"] = EXPECTED_DB
    env["PGSSLMODE"] = parse_qs(parsed.query).get("sslmode", ["disable"])[0]
    return env


def query(env, statement):
    return execute(["psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", statement],
                   env=env, capture=True).strip()


def rows(env, statement):
    output = execute(["psql", "-X", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1",
                      "-c", statement], env=env, capture=True)
    return [line.split("\t") for line in output.splitlines() if line.strip()]


def main():
    if os.geteuid() != 0:
        fail("run as target host root; restricted backup directory is root-owned")
    os.umask(0o077)
    if not (ROOT / ".secrets" / "server.env").is_file():
        fail("target project secret config missing")
    env = pg_env(os.environ.get("DATABASE_URL", ""))
    if query(env, "SELECT current_database()") != EXPECTED_DB:
        fail("wrong connected database")

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive_dir = ROOT / ".secrets" / "backup-drills" / stamp
    archive_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
    dump = archive_dir / "database.dump"
    blobs_tar = archive_dir / "blobs.tar.gz"
    blob_root = ROOT / ".blobs"
    if not blob_root.is_dir() or blob_root.is_symlink():
        fail("expected dedicated .blobs directory missing or symlinked")

    print("BACKUP: snapshotting exact filesmanage_v21 database", flush=True)
    execute(["pg_dump", "-Fc", "--no-owner", "--no-acl", "-f", str(dump)], env=env)
    blobs = rows(env, "SELECT storage_key, sha256 FROM blobs WHERE state='ready' ORDER BY storage_key")
    if not blobs:
        fail("no ready blobs; cannot demonstrate media restore")
    expected = {}
    for key, hash_value in blobs:
        path = PurePosixPath(key)
        if (len(path.parts) != 3 or path.parts[0] != "ready" or
                not re.fullmatch("[0-9a-f]{64}", hash_value) or
                not re.fullmatch("[0-9a-f]{64}", path.parts[-1])):
            fail("invalid or unexpected blob storage key")
        full_path = blob_root.joinpath(*path.parts)
        if not full_path.is_file() or full_path.is_symlink():
            fail("referenced media missing or not regular file")
        if sha256_file(full_path) != hash_value:
            fail("referenced media digest mismatch")
        expected[key] = hash_value

    print(f"BACKUP: verifying and archiving {len(expected)} referenced media objects", flush=True)
    with tarfile.open(blobs_tar, "w:gz") as archive:
        for key in expected:
            archive.add(blob_root / key, arcname=key, recursive=False)
    restore_name = safe_identifier(RESTORE_PREFIX + dt.datetime.now(dt.timezone.utc).strftime("%m%d%H%M%S"))
    created = False
    try:
        execute(["runuser", "-u", "postgres", "--", "createdb", "--owner=filesmanage_v21", restore_name])
        created = True
        restore_env = env.copy()
        restore_env["PGDATABASE"] = restore_name
        print("RESTORE: loading archive into separate scratch PostgreSQL database", flush=True)
        execute(["pg_restore", "--exit-on-error", "--no-owner", "--no-acl", "-d", restore_name, str(dump)],
                env=restore_env)
        tables = rows(restore_env, "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
        table_names = {row[0] for row in tables}
        if not set(REQUIRED_TABLES) <= table_names:
            fail("restored schema is missing required application tables")
        counts = {}
        for table in sorted(table_names):
            counts[table] = int(query(restore_env, f'SELECT count(*) FROM "{table}"'))
        if counts["blobs"] < len(expected) or counts["files"] < 1 or counts["file_versions"] < 1:
            fail("restored business data incomplete")
        restored_blobs = rows(restore_env,
                             "SELECT storage_key, sha256 FROM blobs WHERE state='ready' ORDER BY storage_key")
        if restored_blobs != blobs:
            fail("restored blob manifest differs from backup snapshot")
        with tempfile.TemporaryDirectory(prefix="filesmanage-blobs-verify-", dir=archive_dir) as temp:
            with tarfile.open(blobs_tar, "r:gz") as archive:
                archive.extractall(temp, filter="data")
            for key, digest in expected.items():
                restored_path = Path(temp, *PurePosixPath(key).parts)
                if not restored_path.is_file() or sha256_file(restored_path) != digest:
                    fail("restored media digest differs")
        report = {
            "result": "PASS",
            "source_database": EXPECTED_DB,
            "restored_into_ephemeral_database": restore_name,
            "restored_table_count": len(counts),
            "counts": counts,
            "verified_blob_objects": len(expected),
            "database_archive_sha256": sha256_file(dump),
            "blob_archive_sha256": sha256_file(blobs_tar),
            "completed_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "scratch_database_removed": False,
        }
    finally:
        if created:
            execute(["runuser", "-u", "postgres", "--", "dropdb", restore_name])
    report["scratch_database_removed"] = True
    (archive_dir / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n",
                                              encoding="utf-8")
    print(f"RESTORE_DRILL_PASS tables={len(counts)} blobs={len(expected)} archive={archive_dir}", flush=True)
    print("SCRATCH_DATABASE_REMOVED", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # No DSN, password, or media contents in output.
        print(f"RESTORE_DRILL_FAIL: {exc}", file=sys.stderr)
        sys.exit(1)
