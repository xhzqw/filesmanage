#!/usr/bin/env python3
"""Pure, credential-free tests for restore manifest validation."""
import hashlib
from pathlib import Path
import tempfile
import unittest
import backup_restore_drill as backup


class SnapshotManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.payload = b"verified immutable media bytes\n"
        self.digest = hashlib.sha256(self.payload).hexdigest()
        self.key = f"ready/{self.digest[:2]}/{self.digest}"
        path = self.root / self.key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.payload)

    def test_valid_manifest(self):
        self.assertEqual(backup.snapshot_manifest([(self.key, self.digest)], self.root),
                         {self.key: self.digest})

    def test_reject_duplicate_key(self):
        with self.assertRaisesRegex(RuntimeError, "duplicate"):
            backup.snapshot_manifest([(self.key, self.digest)] * 2, self.root)

    def test_reject_wrong_file_bytes(self):
        (self.root / self.key).write_bytes(b"tampered bytes")
        with self.assertRaisesRegex(RuntimeError, "digest mismatch"):
            backup.snapshot_manifest([(self.key, self.digest)], self.root)

    def test_reject_missing_file(self):
        (self.root / self.key).unlink()
        with self.assertRaisesRegex(RuntimeError, "missing"):
            backup.snapshot_manifest([(self.key, self.digest)], self.root)

    def test_reject_symlink(self):
        real_path = self.root / self.key
        real_path.unlink()
        external = self.root / "external"
        external.write_bytes(self.payload)
        real_path.symlink_to(external)
        with self.assertRaisesRegex(RuntimeError, "regular file"):
            backup.snapshot_manifest([(self.key, self.digest)], self.root)

    def test_reject_wrong_shard(self):
        wrong = f"ready/ee/{self.digest}"
        with self.assertRaisesRegex(RuntimeError, "invalid"):
            backup.snapshot_manifest([(wrong, self.digest)], self.root)

    def test_reject_traversal(self):
        with self.assertRaisesRegex(RuntimeError, "invalid"):
            backup.snapshot_manifest([("../../etc/passwd", self.digest)], self.root)

    def test_reject_wrong_claimed_digest(self):
        with self.assertRaisesRegex(RuntimeError, "invalid"):
            backup.snapshot_manifest([(self.key, "a" * 64)], self.root)

    def test_guard_rejects_different_database(self):
        with self.assertRaisesRegex(RuntimeError, "exact isolated"):
            backup.pg_env("postgresql://example:example@127.0.0.1:5432/postgres")

    def test_guard_rejects_remote_server(self):
        with self.assertRaisesRegex(RuntimeError, "localhost"):
            backup.pg_env("postgresql://example:example@203.0.113.9:5432/filesmanage_v21")

    def test_guard_rejects_invalid_identifier(self):
        with self.assertRaisesRegex(RuntimeError, "unsafe"):
            backup.safe_identifier("filesmanage_restore;DROP")

    def test_empty_manifest(self):
        self.assertEqual(backup.snapshot_manifest([], self.root), {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
