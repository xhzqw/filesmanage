#!/usr/bin/env python3
"""Offline, read-only integrity check for CDW G19 segmented audit packets.

Usage: python3 scripts/verify_cdw_segmented_audit.py CDW-QMS-segmented-audit.json
Integrity verification does not establish signatory identity, regulator
approval, or whether the export was received through an authorized channel.
"""

import base64
import binascii
import hashlib
import json
import sys
from pathlib import Path


class InvalidAudit(ValueError):
    pass


def verify(packet: dict) -> tuple[int, int]:
    if not isinstance(packet, dict) or packet.get("schemaVersion") != "cdw-qms-segmented-v1":
        raise InvalidAudit("not a G19 segmented audit")
    if packet.get("complete") is not True:
        raise InvalidAudit("packet is not marked complete")
    segments = packet.get("segments")
    if not isinstance(segments, list) or not segments:
        raise InvalidAudit("empty segments")
    if len(segments) != packet.get("totalSegments"):
        raise InvalidAudit("segment count mismatch")

    previous_hash = ""
    previous_id = ""
    total = 0
    focus_seen = False
    first_root = packet.get("rootApprovalId")
    focus = packet.get("focusApprovalId")
    if not isinstance(first_root, str) or not first_root or not isinstance(focus, str) or not focus:
        raise InvalidAudit("missing root or focus")

    for idx, segment in enumerate(segments):
        if not isinstance(segment, dict) or segment.get("index") != idx:
            raise InvalidAudit(f"invalid segment index {idx}")
        if segment.get("previousSegmentSha256", "") != previous_hash:
            raise InvalidAudit(f"segment {idx} previous hash mismatch")
        first = segment.get("firstApprovalId")
        last = segment.get("lastApprovalId")
        if not isinstance(first, str) or not isinstance(last, str):
            raise InvalidAudit(f"segment {idx} invalid endpoints")
        try:
            raw = base64.b64decode(segment.get("payloadBase64", ""), validate=True)
            content = json.loads(raw)
        except (ValueError, TypeError, binascii.Error) as exc:
            raise InvalidAudit(f"segment {idx} payload unreadable") from exc
        nodes = content.get("nodes") if isinstance(content, dict) else None
        facts = content.get("facts") if isinstance(content, dict) else None
        if not isinstance(nodes, list) or not 1 <= len(nodes) <= 16:
            raise InvalidAudit(f"segment {idx} node count invalid")
        if not isinstance(facts, dict) or not all(
            isinstance(facts.get(key), list) for key in ("steps", "decisions", "notices")
        ):
            raise InvalidAudit(f"segment {idx} facts malformed")
        if nodes[0].get("approvalId") != first or nodes[-1].get("approvalId") != last:
            raise InvalidAudit(f"segment {idx} endpoints do not match bytes")
        prefix = f"cdw-qms-segment-v1\n{idx}\n{first}\n{last}\n{previous_hash}\n".encode()
        digest = hashlib.sha256(prefix + raw).hexdigest()
        if digest != segment.get("contentSha256"):
            raise InvalidAudit(f"segment {idx} SHA-256 mismatch")
        ids = set()
        for node in nodes:
            if not isinstance(node, dict) or not isinstance(node.get("approvalId"), str):
                raise InvalidAudit(f"segment {idx} invalid node")
            if node.get("previousApprovalId", "") != previous_id:
                raise InvalidAudit(f"segment {idx} broken approval ancestry")
            previous_id = node["approvalId"]
            if previous_id in ids:
                raise InvalidAudit(f"segment {idx} duplicate node")
            ids.add(previous_id)
            if previous_id == focus:
                focus_seen = True
            total += 1
        for key in ("steps", "decisions", "notices"):
            if any(not isinstance(row, dict) or row.get("approvalId") not in ids for row in facts[key]):
                raise InvalidAudit(f"segment {idx} {key} references another segment")
        if idx == 0 and nodes[0]["approvalId"] != first_root:
            raise InvalidAudit("root ID mismatch")
        previous_hash = digest
    if total != packet.get("totalNodes") or not focus_seen:
        raise InvalidAudit("total nodes or selected approval missing")
    if previous_hash != packet.get("lastSegmentSha256"):
        raise InvalidAudit("manifest final SHA-256 mismatch")
    return total, len(segments)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: verify_cdw_segmented_audit.py <exported-json-path>", file=sys.stderr)
        return 2
    try:
        document = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        nodes, segments = verify(document)
    except (OSError, ValueError, TypeError) as exc:
        print(f"CDW_AUDIT_INVALID: {exc}", file=sys.stderr)
        return 1
    print(f"CDW_AUDIT_SEGMENTS_OK nodes={nodes} segments={segments}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
