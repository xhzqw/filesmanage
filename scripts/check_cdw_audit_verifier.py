#!/usr/bin/env python3
"""G19 contract smoke tests for the independently runnable audit validator."""
import base64
import copy
import hashlib
import json
from verify_cdw_segmented_audit import verify, InvalidAudit


def packet():
    segments = []
    prev = ""
    nodes = [
        {"approvalId": f"approval-{i}", **({"previousApprovalId": f"approval-{i - 1}"} if i else {})}
        for i in range(33)
    ]
    for i in range(3):
        piece = nodes[i * 16 : (i + 1) * 16]
        first, last = piece[0]["approvalId"], piece[-1]["approvalId"]
        payload = {"nodes": piece, "facts": {"steps": [], "decisions": [], "notices": []}}
        raw = json.dumps(payload, separators=(",", ":")).encode()
        digest = hashlib.sha256(
            f"cdw-qms-segment-v1\n{i}\n{first}\n{last}\n{prev}\n".encode() + raw
        ).hexdigest()
        segments.append({
            "index": i,
            "firstApprovalId": first,
            "lastApprovalId": last,
            "previousSegmentSha256": prev,
            "contentSha256": digest,
            "payloadBase64": base64.b64encode(raw).decode(),
        })
        prev = digest
    return {
        "schemaVersion": "cdw-qms-segmented-v1",
        "complete": True,
        "focusApprovalId": "approval-25",
        "rootApprovalId": "approval-0",
        "totalNodes": 33,
        "totalSegments": 3,
        "lastSegmentSha256": prev,
        "segments": segments,
    }


def invalid(value):
    try:
        verify(value)
    except InvalidAudit:
        return
    raise AssertionError("tampered packet accepted")


good = packet()
assert verify(good) == (33, 3)
altered = copy.deepcopy(good)
altered["segments"][1]["contentSha256"] = "0" * 64
invalid(altered)
missing = copy.deepcopy(good)
del missing["segments"][1]
invalid(missing)
order = copy.deepcopy(good)
order["segments"][1], order["segments"][2] = order["segments"][2], order["segments"][1]
invalid(order)
bad_payload = copy.deepcopy(good)
bad_payload["segments"][0]["payloadBase64"] = base64.b64encode(b"{}").decode()
invalid(bad_payload)
print("CDW_G19_OFFLINE_AUDIT_VERIFY_PASS 33 nodes, 3 segments and 4 tampering classes")
