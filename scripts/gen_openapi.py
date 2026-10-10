#!/usr/bin/env python3
"""Generate docs/openapi-implemented.yaml from the implemented HTTP surface.

The contract is derived from internal/httpx/router.go and the handler payload
builders. Route table changes must be mirrored here; CI can diff the regenerated
file to detect drift:

    python3 scripts/gen_openapi.py --check
"""
import argparse
import os
import sys

import yaml


class NoAliasDumper(yaml.SafeDumper):
    """Emit every node inline: OpenAPI tooling rejects YAML anchors/aliases."""

    def ignore_aliases(self, data):
        return True


OUT_DEFAULT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "openapi-implemented.yaml")

# --------------------------------------------------------------------------
# Schema helpers
# --------------------------------------------------------------------------


def ref(name):
    return {"$ref": "#/components/schemas/" + name}


def obj(props, required=None, desc=None):
    schema = {"type": "object"}
    if desc:
        schema["description"] = desc
    schema["properties"] = props
    if required:
        schema["required"] = required
    return schema


def arr(items, desc=None):
    schema = {"type": "array", "items": items}
    if desc:
        schema["description"] = desc
    return schema


def string(desc=None, fmt=None, enum=None, max_length=None):
    schema = {"type": "string"}
    if desc:
        schema["description"] = desc
    if fmt:
        schema["format"] = fmt
    if enum:
        schema["enum"] = enum
    if max_length:
        schema["maxLength"] = max_length
    return schema


def integer(desc=None, minimum=None):
    schema = {"type": "integer"}
    if desc:
        schema["description"] = desc
    if minimum is not None:
        schema["minimum"] = minimum
    return schema


def boolean(desc=None):
    schema = {"type": "boolean"}
    if desc:
        schema["description"] = desc
    return schema


def timestamp(desc=None):
    return string(desc, fmt="date-time")


def id_param(name, desc):
    return {
        "name": name,
        "in": "path",
        "required": True,
        "description": desc,
        "schema": {"type": "string"},
    }


def query(name, desc, schema=None, required=False):
    return {
        "name": name,
        "in": "query",
        "required": required,
        "description": desc,
        "schema": schema if schema else {"type": "string"},
    }


# Action vocabularies as the services actually enforce them: grants accept every
# domain action (internal/domain/types.go AllowedAction), shares only the
# read-only triple (internal/application/collaboration.go CreateShare).
GRANT_ACTIONS = ["list", "preview", "upload", "download", "modify", "delete", "rename", "move", "print"]
SHARE_ACTIONS = ["list", "preview", "download"]

# --------------------------------------------------------------------------
# Component schemas (mirrors of internal/httpx payload builders)
# --------------------------------------------------------------------------

SCHEMAS = {}


def schema(name, value):
    SCHEMAS[name] = value


schema("ErrorEnvelope", obj({"ok": {"type": "boolean", "enum": [False]}, "error": obj({"code": string("Stable SPEC 5.3 error code."), "message": string("Present when the server attaches a deliberate public message (e.g. the batch-move limit) or when FILESMANAGE_DEBUG_ERRORS=true.")}, required=["code"])}, required=["ok", "error"]))

schema("SessionUser", obj({
    "id": string(),
    "displayName": string(),
    "isAdmin": boolean(),
    "mustChangePassword": boolean("Deprecated compatibility field; always false for active accounts."),
}, required=["id", "displayName", "isAdmin", "mustChangePassword"]))

schema("User", obj({
    "id": string(),
    "login": string(),
    "displayName": string(),
    "isAdmin": boolean(),
    "departmentId": string(),
    "mustChangePassword": boolean(),
    "disabled": boolean(),
}, required=["id", "login", "displayName", "isAdmin", "departmentId", "mustChangePassword", "disabled"]))

schema("Department", obj({"id": string(), "name": string(), "parentId": string()}, required=["id", "name", "parentId"]))

schema("Workgroup", obj({"id": string(), "name": string(), "departmentId": string()}, required=["id", "name", "departmentId"]))

schema("Folder", obj({"id": string(), "name": string(), "parentId": string()}, required=["id", "name", "parentId"]))

schema("FolderChildrenItem", obj({
    "id": string(),
    "name": string(),
    "parentId": string("Null for a visible root, including a pruned subtree whose real parent the caller may not list."),
    "hasChildren": boolean("True when at least one child folder is listable by the caller; probed server-side with EXISTS, never by loading the children."),
    "canSelect": boolean("UI hint only: the caller holds upload on the folder, so it can be a move/upload target. The transaction that consumes the selection re-verifies."),
    "disabledReason": string("Present only when canSelect is false; a short public reason that never explains visibility."),
}, required=["id", "name", "parentId", "hasChildren", "canSelect"]))

schema("FolderSearchItem", obj({
    "id": string(),
    "name": string(),
    "parentId": string("Null for a visible root, including a pruned subtree whose real parent the caller may not list."),
    "hasChildren": boolean("True when at least one child folder is listable by the caller; probed server-side with EXISTS, never by loading the children."),
    "canSelect": boolean("UI hint only: the caller holds upload on the folder, so it can be a move/upload target. The transaction that consumes the selection re-verifies."),
    "disabledReason": string("Present only when canSelect is false; a short public reason that never explains visibility."),
    "path": string("Listable ancestor names joined with \" / \", truncated at the first ancestor the caller may not list; an orphaned subtree shows its own name only."),
}, required=["id", "name", "parentId", "hasChildren", "canSelect", "path"]))

schema("FolderChildrenPage", obj({
    "items": arr(ref("FolderChildrenItem")),
    "nextCursor": string("Opaque keyset cursor over (name,id); empty on the last page."),
}, required=["items", "nextCursor"]))

schema("FolderSearchPage", obj({
    "items": arr(ref("FolderSearchItem")),
    "nextCursor": string("Opaque keyset cursor over (name,id); empty on the last page."),
}, required=["items", "nextCursor"]))

schema("File", obj({
    "id": string(),
    "folderId": string(),
    "name": string(),
    "uploadedBy": string("Uploader display name."),
    "contentType": string(),
    "sizeBytes": integer(),
    "sha256": string("Hex SHA-256 of the committed content."),
    "updatedAt": timestamp(),
    "currentVersionSeq": integer("Absent when the file has no committed version."),
}, required=["id", "folderId", "name", "uploadedBy", "contentType", "sizeBytes", "sha256", "updatedAt"]))

schema("FileVersion", obj({
    "versionSeq": integer("Monotonic per file; rollback appends a new version."),
    "sha256": string(),
    "sizeBytes": integer(),
    "action": string(enum=["upload", "save", "rollback"]),
    "createdBy": string(),
    "createdAt": timestamp(),
    "baseSeq": integer("Version this change was based on."),
    "rollbackTargetSeq": integer("Present for rollback versions."),
    "rollbackFromSeq": integer("Present for rollback versions."),
    "reason": string(),
}, required=["versionSeq", "sha256", "sizeBytes", "action", "createdBy", "createdAt"]))

schema("FileMeta", obj({"file": ref("File"), "versions": arr(ref("FileVersion"))}, required=["file", "versions"]))

schema("FilePage", obj({"items": arr(ref("File")), "nextCursor": string("Opaque keyset cursor; empty when the page is the last one.")}, required=["items", "nextCursor"]))

schema("Grant", obj({
    "id": string(),
    "folderId": string(),
    "subjectKind": string(enum=["user", "group"]),
    "subjectId": string(),
    "actions": arr(string(enum=GRANT_ACTIONS)),
    "scopeOnly": boolean("When true the grant does not inherit into child folders."),
    "grantedBy": string(),
    "grantedByName": string(),
    "expiresAt": timestamp(),
}, required=["id", "folderId", "subjectKind", "subjectId", "actions", "scopeOnly", "grantedBy", "grantedByName"]))

schema("TrashEntry", obj({
    "id": string(),
    "oldName": string(),
    "deletedBy": string(),
    "deletedByName": string(),
    "deletedAt": timestamp(),
    "fileId": string("Set for deleted files."),
    "folderId": string("Set for deleted folders."),
    "oldParentId": string("Original parent folder id."),
    "subtreeCount": integer("Folders swept into the trash entry."),
}, required=["id", "oldName", "deletedBy", "deletedByName", "deletedAt"]))

schema("Approval", obj({
    "id": string(),
    "fileId": string(),
    "fileName": string(),
    "requesterId": string(),
    "requesterName": string(),
    "approverId": string(),
    "approverName": string(),
    "baseSeq": integer("Version the pending change is based on."),
    "action": string(enum=["edit", "rollback"]),
    "state": string(enum=["pending", "approved", "rejected", "cancelled"]),
    "reason": string(),
    "decisionComment": string(),
    "payloadSha256": string("SHA-256 of the staged pending content."),
    "payloadSize": integer(),
    "createdAt": timestamp(),
    "decidedAt": timestamp(),
    "rollbackTargetSeq": integer(),
}, required=["id", "fileId", "fileName", "requesterId", "requesterName", "approverId", "approverName", "baseSeq", "action", "state", "createdAt"]))

schema("Share", obj({
    "id": string(),
    "recipientKind": string(enum=["user", "group"]),
    "recipientId": string(),
    "recipientName": string(),
    "actions": arr(string(enum=SHARE_ACTIONS)),
    "includeDescendants": boolean(),
    "createdBy": string(),
    "createdAt": timestamp(),
    "fileId": string("Present for file shares."),
    "folderId": string("Present for folder shares."),
    "resourceKind": string(enum=["file", "folder"]),
    "resourceName": string(),
    "expiresAt": timestamp(),
    "revoked": boolean(),
}, required=["id", "recipientKind", "recipientId", "recipientName", "actions", "includeDescendants", "createdBy", "createdAt", "revoked"]))

# Share recipients (WF-21): the minimal picker rows an authenticated share
# creator may read. Users expose a display label only — never login,
# department, admin or disabled state; groups expose id + name.
schema("ShareRecipientUser", obj({
    "id": string(),
    "displayName": string(),
}, required=["id", "displayName"]))

schema("ShareRecipientGroup", obj({
    "id": string(),
    "name": string(),
}, required=["id", "name"]))

schema("ShareRecipientPage", obj({
    "items": arr({"oneOf": [ref("ShareRecipientUser"), ref("ShareRecipientGroup")]},
                 "Rows match the requested kind: user rows carry displayName, group rows carry name."),
    "truncated": boolean("True when more matches exist beyond the capped list; the count itself is not disclosed."),
}, required=["items", "truncated"]))

schema("Favorite", obj({
    "id": string(),
    "resourceName": string(),
    "unavailable": boolean("Resource was deleted; kept for stable ids."),
    "createdAt": timestamp(),
    "fileId": string("Present for file favorites."),
    "folderId": string("Present for folder favorites."),
    "kind": string(enum=["file", "folder"]),
}, required=["id", "resourceName", "unavailable", "createdAt"]))

schema("Preview", obj({
    "fileId": string(),
    "name": string(),
    "contentType": string(),
    "size": integer(),
    "sha256": string(),
    "textual": boolean(),
    "renderer": string(enum=["text", "image", "video", "audio", "unsupported"]),
    "mediaType": string("Signature-verified passive media MIME; empty for other renderers."),
    "truncated": boolean("True when the preview window cut the content."),
    "content": string("Decoded preview text; empty for binary files."),
    "byteMeta": ref("ByteMeta"),
}, required=["fileId", "name", "contentType", "size", "sha256", "textual", "renderer", "mediaType", "truncated", "content", "byteMeta"]))

schema("ByteMeta", obj({
    "size": integer(),
    "sha256": string(),
    "encoding": string(),
    "hasBom": boolean(),
    "eol": string(enum=["lf", "crlf", "cr", "mixed", "none"]),
    "endsWithNewline": boolean(),
    "printable": boolean(),
    "rawBase64": string("Exact preview prefix bytes, base64, for byte-faithful editing."),
}, required=["size", "sha256", "encoding", "hasBom", "eol", "endsWithNewline", "printable"]))

schema("LockStatus", obj({
    "locked": boolean(),
    "ownerName": string("Present when locked."),
    "baseSeq": integer("Version the lock was acquired against."),
    "expiresAt": timestamp(),
}, required=["locked"]))

schema("Derivative", obj({
    "derivativeId": string(),
    "state": string(enum=["queued", "running", "ready", "failed"]),
    "sourceFormat": string(),
    "outputKind": string(),
    "converter": string(),
    "outputSha256": string("Present when ready."),
    "outputSize": integer("Present when ready."),
    "errorCode": string("Present when failed."),
}, required=["derivativeId", "state", "sourceFormat", "outputKind", "converter"]))

schema("DerivativeStatus", obj({
    "found": boolean(),
    "format": string(),
    "class": string(enum=["native", "convert", "licensed", "unsupported"]),
    "engine": string(),
    "note": string("Why the format class applies."),
    "state": string(),
    "outputKind": string(),
    "sourceFormat": string(),
    "converter": string(),
    "outputSha256": string(),
    "outputSize": integer(),
    "errorCode": string(),
}, required=["found", "format", "class", "engine", "note"]))

schema("CadFormat", obj({
    "format": string(),
    "class": string(enum=["native", "convert", "licensed", "unsupported"]),
    "engine": string(),
    "note": string(),
}, required=["format", "class", "engine", "note"]))

schema("Stats", obj({
    "totalFiles": integer(),
    "totalFolders": integer(),
    "totalBytes": integer(),
    "added30Days": integer(),
    "byType": arr(obj({"type": string(), "count": integer()}, required=["type", "count"])),
    "byMonth": arr(obj({"month": string(), "count": integer()}, required=["month", "count"])),
    "byUploader": arr(obj({"uploaderId": string(), "uploaderName": string(), "count": integer()}, required=["uploaderId", "uploaderName", "count"])),
}, required=["totalFiles", "totalFolders", "totalBytes", "added30Days", "byType", "byMonth", "byUploader"]))

schema("SearchResult", obj({
    "items": arr(obj({
        "id": string(),
        "folderId": string(),
        "name": string(),
        "uploadedBy": string(),
        "contentType": string(),
        "sizeBytes": integer(),
        "sha256": string(),
        "updatedAt": timestamp(),
        "currentVersionSeq": integer(),
        "snippet": string("Bounded plain-text window around the match."),
    }, required=["id", "folderId", "name", "uploadedBy", "contentType", "sizeBytes", "sha256", "updatedAt"])),
    "total": integer("Authorized count for the whole filter; the count query ignores the cursor so it stays the same on every page, and it is capped at 1001 (the client displays that as 1000+)."),
    "nextCursor": string("Opaque keyset cursor over the active sort key (updatedAt+id, name+id or size+id); empty on the last page."),
}, required=["items", "total", "nextCursor"]))

schema("OfficeSession", obj({
    "sessionId": string(),
    "documentKey": string(),
    "baseSeq": integer("Locked version for the editing session."),
    "editorUrl": string(),
    "config": {"type": "object", "description": "Signed ONLYOFFICE editor config (document, editorConfig, token)."},
}, required=["sessionId", "documentKey", "baseSeq", "editorUrl", "config"]))

schema("ApprovalPolicy", obj({
    "configured": boolean(),
    "approverId": string("Present when configured."),
    "enabled": boolean("Present when configured."),
}, required=["configured"]))

# Request bodies
schema("LoginRequest", obj({"login": string(max_length=80), "password": string()}, required=["login", "password"]))

schema("PasswordChangeRequest", obj({"oldPassword": string(), "newPassword": string("Must satisfy the password policy.")}, required=["oldPassword", "newPassword"]))

schema("CreateFolderRequest", obj({"parentId": string("Target parent folder id."), "name": string()}, required=["parentId", "name"]))

schema("RenameFolderRequest", obj({"name": string()}, required=["name"]))

schema("MoveFolderRequest", obj({"targetParentId": string()}, required=["targetParentId"]))

schema("CreateGrantRequest", obj({
    "subjectKind": string(enum=["user", "group"]),
    "subjectId": string(),
    "actions": arr(string(enum=GRANT_ACTIONS)),
    "scopeOnly": boolean(),
    "expiresAt": timestamp("Optional grant expiry."),
}, required=["subjectKind", "subjectId", "actions"]))

schema("PermissionSource", obj({
    "kind": string(enum=["direct_acl", "inherited_acl", "workgroup_acl", "folder_share", "admin_override"]),
    "resourceId": string(), "grantId": string(),
    "subjectKind": string(), "subjectId": string(),
    "actions": arr(string(enum=GRANT_ACTIONS)), "scopeOnly": boolean(),
    "depth": integer(), "expiresAt": timestamp(),
}, required=["kind", "resourceId", "actions", "scopeOnly", "depth"]))

schema("PermissionExplanation", obj({
    "subjectKind": string(enum=["user"]), "subjectId": string(), "folderId": string(),
    "subjectDisabled": boolean(), "subjectRequiresPasswordChange": boolean(),
    "effectiveActions": arr(string(enum=GRANT_ACTIONS)),
    "sources": arr(ref("PermissionSource")), "evaluatedAt": timestamp(),
}, required=["subjectKind", "subjectId", "folderId", "subjectDisabled", "subjectRequiresPasswordChange",
             "effectiveActions", "sources", "evaluatedAt"]))

schema("PermissionAuditEntry", obj({
    "id": integer(), "actorId": string(), "requestId": string(),
    "eventType": string(), "targetKind": string(),
    "targetId": string(), "outcome": string(), "details": {"type": "object"},
    "createdAt": timestamp(),
}, required=["id", "actorId", "requestId", "eventType", "targetKind", "targetId", "outcome", "details", "createdAt"]))

schema("PermissionAuditPage", obj({
    "items": arr(ref("PermissionAuditEntry")), "nextCursor": string(),
}, required=["items", "nextCursor"]))

schema("ManagementRoleBinding", obj({
    "id": string(), "userId": string(), "role": string(enum=["auditor","permission_admin"]),
    "scopeKind": string(enum=["global","folder"]), "scopeId": string(),
    "allowedActions": arr(string(enum=GRANT_ACTIONS)), "expiresAt": timestamp(),
    "grantedBy": string(), "createdAt": timestamp(), "revokedAt": timestamp(),
}, required=["id","userId","role","scopeKind","scopeId","allowedActions","grantedBy","createdAt"]))

schema("CreateRoleBindingRequest", obj({
    "userId": string(), "role": string(enum=["auditor","permission_admin"]),
    "scopeId": string(), "allowedActions": arr(string(enum=GRANT_ACTIONS)),
    "expiresAt": timestamp(),
}, required=["userId","role"]))

schema("SaveFileRequest", obj({
    "data": string("Raw base64 body or a data: URL; bytes are written verbatim."),
    "baseSeq": integer("Optimistic concurrency base version.", minimum=1),
    "lockToken": string("Edit lock token when the folder requires locking."),
    "idempotencyKey": string("Replay-safe write key."),
}, required=["data", "baseSeq"]))

schema("RollbackFileRequest", obj({
    "targetSeq": integer("Version to roll back to.", minimum=1),
    "expectedCurrentSeq": integer("Current version at request time; mismatch yields 409.", minimum=1),
    "lockToken": string(),
    "reason": string(),
    "idempotencyKey": string(),
}, required=["targetSeq", "expectedCurrentSeq"]))

schema("RenameFileRequest", obj({"name": string()}, required=["name"]))

schema("MoveFileRequest", obj({
    "targetFolderId": string("Destination folder id."),
    "expectedFolderId": string("CAS guard: the file's current folder; a mismatch yields 409 E_VERSION_CONFLICT."),
    "idempotencyKey": string("Replay-safe move key; a repeat returns the recorded result."),
}, required=["targetFolderId"]))

schema("MovePreflightRequest", obj({
    "resources": arr(obj({"kind": string(enum=["file"]), "id": string()}, required=["kind", "id"]), "Resources under preflight."),
    "targetFolderId": string("Candidate destination folder id."),
    "mode": string(enum=["all_or_nothing"]),
}, required=["resources", "targetFolderId"]))

schema("MovePreflightResult", obj({
    "status": string(enum=["ready", "conflict", "forbidden"]),
    "candidateRevision": string("Opaque per-call revision; never an authorization token."),
    "allowedCount": integer("Resources that would move cleanly."),
    "conflicts": arr(obj({"id": string(), "code": string("Stable envelope code the commit would answer."), "message": string()})),
    "warnings": arr(string()),
    "sourceSummary": string("Visible source folder paths only; hidden ancestors truncate the path."),
    "targetSummary": string("Visible target folder path only; hidden ancestors truncate the path."),
}, required=["status", "candidateRevision", "allowedCount", "conflicts", "warnings", "sourceSummary", "targetSummary"]))

schema("MoveBatchRequest", obj({
    "fileIds": arr(string(), "Distinct file ids; all moved together or none. At most 100 per request."),
    "targetFolderId": string("Shared destination folder id."),
    "mode": string(enum=["all_or_nothing"]),
    "idempotencyKey": string("Replay-safe batch key; a repeat returns the recorded result."),
}, required=["fileIds", "targetFolderId"]))

schema("MoveBatchResult", obj({
    "status": string(enum=["committed", "conflict"]),
    "moved": arr(obj({"fileId": string(), "fromFolderId": string(), "toFolderId": string()}, required=["fileId", "fromFolderId", "toFolderId"]),
                 "Moved files in request order; empty on conflict."),
    "conflicts": arr(obj({"id": string(), "code": string("Stable envelope code the single-file commit would answer."), "message": string()}),
                     "Per-item failures; empty on commit. When any entry exists nothing was written."),
    "count": integer("Files moved on committed; conflicts reported on conflict."),
}, required=["status", "moved", "conflicts", "count"]))

schema("CreateUserRequest", obj({
    "login": string(max_length=80),
    "displayName": string(),
    "departmentId": string(),
    "isAdmin": boolean(),
    "password": string("Initial password; must be changed on first login."),
}, required=["login", "displayName", "departmentId", "password"]))

schema("ResetUserPasswordRequest", obj({"password": string()}, required=["password"]))

schema("CreateDepartmentRequest", obj({"name": string(), "parentId": string()}, required=["name", "parentId"]))

schema("CreateWorkgroupRequest", obj({"name": string(), "departmentId": string()}, required=["name", "departmentId"]))

schema("AddWorkgroupMemberRequest", obj({"userId": string()}, required=["userId"]))

schema("AcquireLockRequest", obj({"baseSeq": integer(minimum=1)}, required=["baseSeq"]))

schema("LockTokenRequest", obj({"lockToken": string()}, required=["lockToken"]))

schema("ApprovalDecisionRequest", obj({"comment": string("Optional decision note recorded in the audit trail.")}))

schema("SetApprovalPolicyRequest", obj({"approverId": string(), "enabled": boolean()}, required=["approverId", "enabled"]))

schema("CreateShareRequest", obj({
    "resourceKind": string(enum=["file", "folder"]),
    "resourceId": string(),
    "recipientKind": string(enum=["user", "group"]),
    "recipientId": string(),
    "actions": arr(string(enum=SHARE_ACTIONS)),
    "includeDescendants": boolean("Folder shares only."),
    "expiresAt": timestamp(),
}, required=["resourceKind", "resourceId", "recipientKind", "recipientId", "actions"]))

schema("RestoreTrashRequest", obj({"destinationFolderId": string("Restore target; empty keeps the original parent."), "newName": string("Rename on restore; empty keeps the old name.")}))

schema("EditorCallback", obj({
    "key": string("Document key from the editor config."),
    "status": integer("1=editing, 2=ready to save, 4=closed, 6=force save."),
    "url": string("Download URL of the saved document."),
}, required=["key", "status", "url"]))

# --------------------------------------------------------------------------
# Route table
# --------------------------------------------------------------------------

SESSION = [{"cookieSession": []}]
OFFICE_JWT = [{"officeJWT": []}]
SOURCE_TOKEN = [{"officeSourceToken": []}]

ERR = {
    "400": "E_BAD — malformed request body or parameters",
    "401": "E_AUTH — missing or expired session",
    "403": "E_FORBIDDEN — authorization denied",
    "404": "E_NOT_FOUND",
    "409": "Conflict — E_NAME_CONFLICT, E_VERSION_CONFLICT, E_LOCKED, E_APPROVAL_PENDING or E_PARENT_MISSING",
    "410": "Resource permanently removed",
    "413": "E_TOO_LARGE — body exceeds the upload limit",
    "422": "E_PASSWORD_POLICY — password does not satisfy the policy",
    "500": "E_INTERNAL",
    "503": "E_DEPENDENCY — database unavailable",
}

MUST_CHANGE = ""  # No forced first-login credential rotation.


def resp(code, desc, schema_value=None):
    entry = {"description": desc}
    if schema_value is not None:
        entry["content"] = {"application/json": {"schema": schema_value}}
    elif code.isdigit() and int(code) >= 400:
        # SPEC 5.3 error envelope: every failure is {"ok": false, "error": {...}}.
        entry["content"] = {"application/json": {"schema": ref("ErrorEnvelope")}}
    return code, entry


def json_ok(data_ref, desc):
    return resp("200", desc, obj({"ok": {"type": "boolean", "enum": [True]}, "data": data_ref}, required=["ok", "data"]))


def errors(*codes):
    out = {}
    for code in codes:
        out[code] = {"description": ERR[code], "content": {"application/json": {"schema": ref("ErrorEnvelope")}}}
    return out


def operation(summary, tag, op_id, security=None, params=None, request=None, responses=None, auth_note=None):
    op = {"summary": summary, "operationId": op_id, "tags": [tag]}
    if security is not None:
        op["security"] = security
    if params:
        op["parameters"] = params
    if request is not None:
        op["requestBody"] = {"required": True, "content": request}
    desc = {}
    desc.update(responses or {})
    op["responses"] = desc
    if auth_note:
        op["description"] = auth_note
    return op


ROUTES = []


def add(method, path, op):
    ROUTES.append((method, path, op))


# --- Health (outside /api) ---
OK_SCHEMA = obj({"ok": {"type": "boolean", "enum": [True]}})
add("GET", "/health/live", operation("Liveness probe", "Health", "healthLive", security=[],
    responses={"200": {"description": "Process alive", "content": {"application/json": {"schema": OK_SCHEMA}}}}))
add("GET", "/health/ready", operation("Readiness probe (PostgreSQL reachable)", "Health", "healthReady", security=[],
    responses={"200": {"description": "Database reachable", "content": {"application/json": {"schema": OK_SCHEMA}}},
               "503": {"description": ERR["503"]}}))

# --- Auth ---
add("POST", "/api/login", operation("Authenticate and open a session", "Auth", "login", security=[],
    request={"application/json": {"schema": ref("LoginRequest")}},
    responses=dict([json_ok(ref("SessionUser"), "Session cookie set (HttpOnly, SameSite=Strict)."),
                    resp("400", ERR["400"]), resp("401", ERR["401"] + " (E_INVALID_CREDENTIALS)")])))

add("POST", "/api/logout", operation("Revoke the current session", "Auth", "logout", security=SESSION,
    responses={"200": {"description": "Session revoked and cookie cleared"}}))

add("POST", "/api/me/password", operation("Change own password (forced on first login)", "Auth", "changePassword", security=SESSION,
    request={"application/json": {"schema": ref("PasswordChangeRequest")}},
    responses=dict([json_ok(ref("SessionUser"), "Password changed; old password immediately invalid."),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("422", ERR["422"])])))

add("GET", "/api/me", operation("Current session user", "Auth", "currentUser", security=SESSION,
    responses=dict([json_ok(ref("SessionUser"), "Authenticated user."), resp("401", ERR["401"])])))

# Session inventory: each row is public, never the bearer cookie itself.
SESSION_DEVICE = obj({
    "id": string("96-bit prefix of session-token SHA-256; selector only, not a bearer token."),
    "device": string("Coarse browser and operating-system label."),
    "address": string("Authenticated socket client IP or trusted Nginx-forwarded IP."),
    "createdAt": {"type": "string", "format": "date-time"},
    "lastSeenAt": {"type": "string", "format": "date-time"},
    "expiresAt": {"type": "string", "format": "date-time"},
    "current": {"type": "boolean"}
}, required=["id", "device", "address", "createdAt", "lastSeenAt", "expiresAt", "current"])
SESSION_ACTIVITY = obj({
    "type": string("auth.login, auth.logout, auth.session_revoke or auth.sessions_revoke"),
    "outcome": string("success or denied"),
    "device": string(), "address": string(), "count": integer(),
    "occurredAt": {"type": "string", "format": "date-time"}
}, required=["type", "outcome", "device", "address", "occurredAt"])
add("GET", "/api/me/sessions", operation("List own active login devices", "Auth", "listOwnSessions",
    security=SESSION, responses=dict([json_ok(arr(SESSION_DEVICE), "At most 50 own sessions; includes current marker."),
        resp("401", ERR["401"]), resp("403", ERR["403"]), resp("503", ERR["503"])]), auth_note=MUST_CHANGE))
add("GET", "/api/me/auth-activity", operation("List own recent account security actions", "Auth", "listOwnAuthActivity",
    security=SESSION, responses=dict([json_ok(arr(SESSION_ACTIVITY), "At most 30 own login/logout/revoke audit records."),
        resp("401", ERR["401"]), resp("403", ERR["403"]), resp("503", ERR["503"])]), auth_note=MUST_CHANGE))
add("DELETE", "/api/me/sessions/others", operation("Revoke every other active session", "Auth", "revokeOtherSessions",
    security=SESSION, responses=dict([json_ok(obj({"revoked": integer()}, required=["revoked"]), "Number of other sessions revoked."),
        resp("401", ERR["401"]), resp("403", ERR["403"]), resp("503", ERR["503"])]), auth_note=MUST_CHANGE))
add("DELETE", "/api/me/sessions/{id}", operation("Revoke a single other session belonging to the caller", "Auth", "revokeOwnSession",
    security=SESSION, params=[id_param("id", "24 lowercase hexadecimal characters, never a bearer token.")],
    responses=dict([json_ok(obj({"revoked": {"type": "boolean"}}, required=["revoked"]), "Other session revoked."),
        resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("503", ERR["503"])]),
    auth_note=MUST_CHANGE + " Foreign-account IDs and missing IDs are indistinguishable (404). Current session cannot be revoked here."))

# RFC 6455 upgrade: same-origin, Cookie-authenticated, outbound JSON events.
add("GET", "/api/events/ws", operation("Subscribe to live session events (WebSocket)", "Auth",
    "sessionEventsWebSocket", security=SESSION,
    responses={"101": {"description": "Switching Protocols: WebSocket JSON events (connection.ready, connection.heartbeat, session.changed, session.revoked, server.unavailable)."},
               "401": {"description": ERR["401"]},
               "403": {"description": "E_ORIGIN"},
               "426": {"description": "E_UPGRADE_REQUIRED — WebSocket Upgrade required"},
               "503": {"description": "E_LIVE_CAPACITY — live connection limit reached"}},
    auth_note="Origin must match Host, scheme and port; uses HttpOnly cookie, no URL token. Browser clients connect via ws:// on HTTP or wss:// on HTTPS. Up to 128 live connections per server process and 12-second heartbeat. Server-to-client JSON messages only; each event revalidates the session. Existing HTTP APIs remain authoritative."))

# --- Folders ---
add("GET", "/api/folders/tree", operation("Authorized folder tree", "Folders", "folderTree", security=SESSION,
    responses=dict([json_ok(arr(ref("Folder")), "Folders the caller may see, with parent links."), resp("401", ERR["401"]), resp("403", ERR["403"])]),
    auth_note=MUST_CHANGE))

# The paged FolderPicker reads (COMPLEX-WORKFLOWS §2.3 / ADR-UX-07). /folders/tree
# stays the whole-tree read for small trees; these two page a large tree on demand.
FOLDER_PAGE_PARAMS = [
    query("limit", "Page size; defaults to 50 and is capped at 200.", {"type": "integer", "minimum": 1, "maximum": 200}),
    query("cursor", "Opaque keyset cursor from nextCursor over the (name,id) sort key."),
]

add("GET", "/api/folders/children", operation("List one page of a folder's visible children (keyset pagination)", "Folders", "folderChildren", security=SESSION,
    params=[query("parentId", "Parent folder id; empty or absent lists the caller's visible roots, including a pruned subtree whose parent is not visible.")] + FOLDER_PAGE_PARAMS,
    responses=dict([json_ok(ref("FolderChildrenPage"), "Authorized page, name-ordered. A parent the caller may not list answers exactly like a missing one."),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]),
                    resp("404", "E_NOT_FOUND — the parent is missing, trashed, or not listable by the caller (indistinguishable on purpose)")]),
    auth_note=MUST_CHANGE))

add("GET", "/api/folders/search", operation("Search visible folders by name (keyset pagination)", "Folders", "searchFolders", security=SESSION,
    params=[query("q", "Folder name fragment; required and non-blank (400 E_BAD otherwise).", required=True)] + FOLDER_PAGE_PARAMS,
    responses=dict([json_ok(ref("FolderSearchPage"), "Authorized matches, each with its visible path truncated at a hidden ancestor."),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"])]),
    auth_note=MUST_CHANGE))

add("POST", "/api/folders", operation("Create a folder", "Folders", "createFolder", security=SESSION,
    request={"application/json": {"schema": ref("CreateFolderRequest")}},
    responses=dict([resp("201", "Folder created", obj({"ok": {"type": "boolean", "enum": [True]}, "data": ref("Folder")}, required=["ok", "data"])),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("409", ERR["409"])])))

add("PATCH", "/api/folders/{id}", operation("Rename a folder", "Folders", "renameFolder", security=SESSION,
    params=[id_param("id", "Folder id.")],
    request={"application/json": {"schema": ref("RenameFolderRequest")}},
    responses=dict([json_ok(ref("Folder"), "Renamed folder."), resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("409", ERR["409"])])))

add("POST", "/api/folders/{id}/move", operation("Move a folder to another parent", "Folders", "moveFolder", security=SESSION,
    params=[id_param("id", "Folder id.")],
    request={"application/json": {"schema": ref("MoveFolderRequest")}},
    responses=dict([json_ok(ref("Folder"), "Moved folder."), resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("409", ERR["409"])])))

add("DELETE", "/api/folders/{id}", operation("Delete a folder subtree into the trash", "Folders", "deleteFolder", security=SESSION,
    params=[id_param("id", "Folder id.")],
    responses=dict([json_ok(obj({"trashId": string(), "folders": integer("Folders swept into this trash entry."), "oldName": string()}, required=["trashId", "folders", "oldName"]), "Trash entry covering the subtree."),
                    resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

add("GET", "/api/folders/{id}/acls", operation("List grants on a folder", "Grants", "listGrants", security=SESSION,
    params=[id_param("id", "Folder id.")],
    responses=dict([json_ok(arr(ref("Grant")), "Grants on the folder."), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

add("POST", "/api/folders/{id}/acls", operation("Grant actions to a subject", "Grants", "createGrant", security=SESSION,
    params=[id_param("id", "Folder id.")],
    request={"application/json": {"schema": ref("CreateGrantRequest")}},
    responses=dict([resp("201", "Grant created", obj({"ok": {"type": "boolean", "enum": [True]}, "data": ref("Grant")}, required=["ok", "data"])),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("409", ERR["409"])])))

add("DELETE", "/api/acls/{id}", operation("Revoke a grant", "Grants", "revokeGrant", security=SESSION,
    params=[id_param("id", "Grant id.")],
    responses=dict([json_ok(obj({"revoked": string()}, required=["revoked"]), "Revoked grant id."), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

add("POST", "/api/permissions/explain", operation("Explain user's effective folder permissions (admin only)", "Grants", "explainPermissions", security=SESSION,
    request={"application/json": {"schema": obj({
        "subjectKind": string(enum=["user"]), "subjectId": string(), "folderId": string(),
    }, required=["subjectKind", "subjectId", "folderId"])}},
    responses=dict([json_ok(ref("PermissionExplanation"), "Effective actions and applied sources from the authoritative resolver."),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])]),
    auth_note=MUST_CHANGE))

add("GET", "/api/permissions/audit", operation("Read paged permission-change audit (admin or auditor)", "Grants", "permissionAudit", security=SESSION,
    params=[query("cursor", "Descending numeric audit id before which to read."),
            query("limit", "Rows per page, 1-100 (default 30).", integer(minimum=1))],
    responses=dict([json_ok(ref("PermissionAuditPage"), "Only access-changing events, descending audit id."),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"])]),
    auth_note=MUST_CHANGE))

add("GET", "/api/roles/me", operation("Read current management roles", "Roles", "myRoles", security=SESSION,
    responses=dict([json_ok(arr(ref("ManagementRoleBinding")), "Current user's active management roles."),
                    resp("401", ERR["401"]),resp("403", ERR["403"])])))
add("GET", "/api/roles/bindings", operation("List role assignments (admin)", "Roles", "listRoleBindings", security=SESSION,
    responses=dict([json_ok(arr(ref("ManagementRoleBinding")), "Non-revoked bounded role bindings."),
                    resp("401", ERR["401"]),resp("403", ERR["403"])])))
add("POST", "/api/roles/bindings", operation("Delegate management permission (admin)", "Roles", "createRoleBinding", security=SESSION,
    request={"application/json":{"schema":ref("CreateRoleBindingRequest")}},
    responses=dict([resp("201","Created",obj({"ok":boolean(),"data":ref("ManagementRoleBinding")},required=["ok","data"])),
                    resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("DELETE", "/api/roles/bindings/{id}", operation("Revoke management role binding (admin)", "Roles", "revokeRoleBinding", security=SESSION,
    params=[id_param("id","Management role binding ID")],
    responses=dict([json_ok(obj({"revoked":string()},required=["revoked"]),"Revoked binding."),
                    resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))

# --- Files ---
add("POST", "/api/files", operation("Upload a file (multipart, idempotent)", "Files", "uploadFile", security=SESSION,
    request={"multipart/form-data": {"schema": obj({
        "file": {"type": "string", "format": "binary", "description": "File content."},
        "folderId": string("Destination folder id."),
        "idempotencyKey": string("Replay-safe upload key."),
    }, required=["file", "folderId"])}},
    responses=dict([resp("201", "Committed (or deduplicated)", obj({"ok": {"type": "boolean", "enum": [True]}, "data": obj({
        "fileId": string(), "versionSeq": integer(), "sha256": string(), "size": integer(), "name": string(), "folderId": string(), "deduplicated": boolean(),
    }, required=["fileId", "versionSeq", "sha256", "size", "name", "folderId", "deduplicated"])}, required=["ok", "data"])),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("409", ERR["409"]), resp("413", ERR["413"])])))

add("GET", "/api/files", operation("List files in a folder (keyset pagination)", "Files", "listFiles", security=SESSION,
    params=[query("folder", "Folder id; empty lists across authorized scope.", required=True),
            query("limit", "Page size (clamped server-side).", {"type": "integer", "minimum": 1, "maximum": 200}),
            query("sort", "Sort key (ListFiles accepts only these; anything else is 400 E_BAD).", {"type": "string", "enum": ["updated_desc", "updated_asc", "name_asc", "name_desc", "size_desc"]}),
            query("cursor", "Opaque keyset cursor from nextCursor.")],
    responses=dict([json_ok(ref("FilePage"), "Authorized file page."), resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"])]),
    auth_note=MUST_CHANGE))

add("GET", "/api/files/{id}", operation("File metadata with version history", "Files", "fileMeta", security=SESSION,
    params=[id_param("id", "File id.")],
    responses=dict([json_ok(ref("FileMeta"), "File and its full version history."), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

add("PATCH", "/api/files/{id}", operation("Rename a file", "Files", "renameFile", security=SESSION,
    params=[id_param("id", "File id.")],
    request={"application/json": {"schema": ref("RenameFileRequest")}},
    responses=dict([json_ok(ref("File"), "Renamed file."), resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("409", ERR["409"])])))

add("GET", "/api/files/{id}/bytes", operation("Download file content (Range supported)", "Files", "downloadFile", security=SESSION,
    params=[id_param("id", "File id.")],
    responses={"200": {"description": "Immutable content-addressed bytes. Supports Range (206/416), ETag and If-Range.",
                       "headers": {"X-Content-Sha256": {"schema": {"type": "string"}, "description": "Hex SHA-256 of the served bytes."}},
                       "content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}},
               "401": {"description": ERR["401"]}, "403": {"description": ERR["403"]}, "404": {"description": ERR["404"]}}))

add("GET", "/api/files/{id}/preview", operation("Preview content and byte-fidelity metadata", "Files", "previewFile", security=SESSION,
    params=[id_param("id", "File id.")],
    responses=dict([json_ok(ref("Preview"), "Preview window with byte metadata for lossless round-trips."), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

add("GET", "/api/files/{id}/preview/media", operation("Stream passive media preview (Range supported, preview ACL)", "Files", "previewMedia", security=SESSION,
    params=[id_param("id", "File id.")],
    responses={"200": {"description": "Verified image/video/audio bytes with Content-Disposition: inline. Supports Range, ETag and If-Range.",
                       "content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}},
               "206": {"description": "Partial media content for seek."},
               "401": {"description": ERR["401"]}, "403": {"description": ERR["403"]},
               "404": {"description": ERR["404"]}, "415": {"description": "Unsupported or unsafe inline format."},
               "416": {"description": "Unsatisfiable media Range."}}))

add("POST", "/api/files/{id}/save", operation("Save new file content (new version, idempotent)", "Files", "saveFile", security=SESSION,
    params=[id_param("id", "File id.")],
    request={"application/json": {"schema": ref("SaveFileRequest")}},
    responses=dict([json_ok(obj({"fileId": string(), "versionSeq": integer(), "sha256": string(), "size": integer(), "status": {"type": "string", "enum": ["committed"]}}, required=["fileId", "versionSeq", "sha256", "size", "status"]), "New version committed."),
                    resp("202", "Approval required; content staged", obj({"ok": {"type": "boolean", "enum": [True]}, "data": obj({"status": {"type": "string", "enum": ["pending"]}, "approvalId": string(), "expectedCurrentSeq": integer(), "lockReleased": boolean()}, required=["status", "approvalId", "expectedCurrentSeq", "lockReleased"])}, required=["ok", "data"])),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("409", ERR["409"])])))

add("GET", "/api/files/{id}/versions", operation("Full version history", "Files", "fileVersions", security=SESSION,
    params=[id_param("id", "File id.")],
    responses=dict([json_ok(arr(ref("FileVersion")), "Versions oldest first; rollback entries carry rollbackTargetSeq."), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

add("POST", "/api/files/{id}/rollback", operation("Roll back to an earlier version (append-only)", "Files", "rollbackFile", security=SESSION,
    params=[id_param("id", "File id.")],
    request={"application/json": {"schema": ref("RollbackFileRequest")}},
    responses=dict([json_ok(obj({"fileId": string(), "versionSeq": integer("The new appended version."), "sha256": string(), "size": integer(), "status": {"type": "string", "enum": ["committed"]}}, required=["fileId", "versionSeq", "sha256", "size", "status"]), "New version appended with the target content; history preserved."),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("409", ERR["409"])])))

add("POST", "/api/files/{id}/move", operation("Move a file to another folder (CAS + idempotent)", "Files", "moveFile", security=SESSION,
    params=[id_param("id", "File id.")],
    request={"application/json": {"schema": ref("MoveFileRequest")}},
    responses=dict([json_ok(obj({"fileId": string(), "fromFolderId": string(), "toFolderId": string(), "status": {"type": "string", "enum": ["committed"]}}, required=["fileId", "fromFolderId", "toFolderId", "status"]), "File moved in one transaction; id, version history and content hash unchanged."),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]),
                    resp("409", "Conflict — E_NAME_CONFLICT (live name in target), E_VERSION_CONFLICT (stale expectedFolderId) or E_MOVE_CONFLICT (target is the current folder)")]),
    auth_note=MUST_CHANGE))

add("POST", "/api/files/move-batch", operation("Move a batch of files into one folder (all-or-nothing, idempotent)", "Files", "moveFilesBatch", security=SESSION,
    request={"application/json": {"schema": ref("MoveBatchRequest")}},
    responses=dict([json_ok(ref("MoveBatchResult"), "Batch verdict. committed: every file moved; conflict: nothing was written and each failing item is listed."),
                    resp("400", ERR["400"] + " — an over-limit batch states the 100-file limit in error.message"),
                    resp("401", ERR["401"]), resp("403", ERR["403"]),
                    resp("409", "Conflict — E_NAME_CONFLICT when a concurrent write takes a target name between validation and commit; the whole batch rolls back")]),
    auth_note=MUST_CHANGE))

add("POST", "/api/moves/preflight", operation("Read-only preflight for a candidate move", "Files", "preflightMoves", security=SESSION,
    request={"application/json": {"schema": ref("MovePreflightRequest")}},
    responses=dict([json_ok(ref("MovePreflightResult"), "Preflight verdict; UX only, never an authorization proof."),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])]),
    auth_note=MUST_CHANGE))

add("DELETE", "/api/files/{id}", operation("Delete a file into the trash", "Files", "deleteFile", security=SESSION,
    params=[id_param("id", "File id.")],
    responses=dict([json_ok(ref("TrashEntry"), "Trash entry for the file."), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

# --- Organization ---
add("GET", "/api/users", operation("List users", "Organization", "listUsers", security=SESSION,
    params=[query("limit", "Enable keyset paging with 1–200 records; default 100 if only cursor is supplied.", integer(minimum=1)),
            query("cursor", "Last returned ID from nextCursor; use with limit.")],
    responses=dict([json_ok({"oneOf":[arr(ref("User")),
        obj({"items":arr(ref("User")), "nextCursor":string()},required=["items","nextCursor"])]},
        "Legacy no-query array (capped at 1000), or {items,nextCursor} when paged."),
        resp("400", ERR["400"]),resp("401", ERR["401"]), resp("403", ERR["403"])])))

add("POST", "/api/users", operation("Create a user", "Organization", "createUser", security=SESSION,
    request={"application/json": {"schema": ref("CreateUserRequest")}},
    responses=dict([resp("201", "User created", obj({"ok": {"type": "boolean", "enum": [True]}, "data": ref("User")}, required=["ok", "data"])),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("409", ERR["409"])])))

add("POST", "/api/users/{id}/password", operation("Reset a user's password (admin)", "Organization", "resetUserPassword", security=SESSION,
    params=[id_param("id", "User id.")],
    request={"application/json": {"schema": ref("ResetUserPasswordRequest")}},
    responses=dict([json_ok(obj({"reset": string()}, required=["reset"]), "Reset user id."), resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("422", ERR["422"])])))

add("POST", "/api/users/{id}/{state}", operation("Enable or disable a user", "Organization", "setUserDisabled", security=SESSION,
    params=[id_param("id", "User id."),
            {"name": "state", "in": "path", "required": True, "schema": {"type": "string", "enum": ["disable", "enable"]}, "description": "Target state."}],
    responses=dict([json_ok(obj({"id": string(), "disabled": boolean()}, required=["id", "disabled"]), "Resulting state."), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

add("GET", "/api/departments", operation("List departments", "Organization", "listDepartments", security=SESSION,
    responses=dict([json_ok(arr(ref("Department")), "Department tree."), resp("401", ERR["401"]), resp("403", ERR["403"])])))

add("POST", "/api/departments", operation("Create a department", "Organization", "createDepartment", security=SESSION,
    request={"application/json": {"schema": ref("CreateDepartmentRequest")}},
    responses=dict([resp("201", "Department created", obj({"ok": {"type": "boolean", "enum": [True]}, "data": obj({"id": string(), "name": string()}, required=["id", "name"])}, required=["ok", "data"])),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"])])))

add("GET", "/api/groups", operation("List workgroups", "Organization", "listWorkgroups", security=SESSION,
    params=[query("limit", "Enable keyset paging with 1–200 records; default 100 if only cursor is supplied.", integer(minimum=1)),
            query("cursor", "Last returned ID from nextCursor; use with limit.")],
    responses=dict([json_ok({"oneOf":[arr(ref("Workgroup")),
        obj({"items":arr(ref("Workgroup")), "nextCursor":string()},required=["items","nextCursor"])]},
        "Legacy no-query array (capped at 1000), or {items,nextCursor} when paged."),
        resp("400", ERR["400"]),resp("401", ERR["401"]), resp("403", ERR["403"])])))

add("POST", "/api/groups", operation("Create a workgroup", "Organization", "createWorkgroup", security=SESSION,
    request={"application/json": {"schema": ref("CreateWorkgroupRequest")}},
    responses=dict([resp("201", "Workgroup created", obj({"ok": {"type": "boolean", "enum": [True]}, "data": obj({"id": string(), "name": string()}, required=["id", "name"])}, required=["ok", "data"])),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"])])))

add("GET", "/api/groups/{id}/members", operation("List workgroup members", "Organization", "workgroupMembers", security=SESSION,
    params=[id_param("id", "Workgroup id.")],
    responses=dict([json_ok(arr(ref("User")), "Members."), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

add("POST", "/api/groups/{id}/members", operation("Add a workgroup member", "Organization", "addWorkgroupMember", security=SESSION,
    params=[id_param("id", "Workgroup id.")],
    request={"application/json": {"schema": ref("AddWorkgroupMemberRequest")}},
    responses=dict([resp("201", "Member added", obj({"ok": {"type": "boolean", "enum": [True]}, "data": obj({"groupId": string(), "userId": string()}, required=["groupId", "userId"])}, required=["ok", "data"])),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

add("DELETE", "/api/groups/{id}/members/{uid}", operation("Remove a workgroup member", "Organization", "removeWorkgroupMember", security=SESSION,
    params=[id_param("id", "Workgroup id."), id_param("uid", "User id.")],
    responses=dict([json_ok(obj({"groupId": string(), "userId": string(), "removed": {"type": "boolean", "enum": [True]}}, required=["groupId", "userId", "removed"]), "Member removed."),
                    resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

# --- Locks ---
add("POST", "/api/files/{id}/lock", operation("Acquire an edit lock", "Workflow", "acquireLock", security=SESSION,
    params=[id_param("id", "File id.")],
    request={"application/json": {"schema": ref("AcquireLockRequest")}},
    responses=dict([resp("201", "Lock acquired", obj({"ok": {"type": "boolean", "enum": [True]}, "data": obj({"lockToken": string(), "generation": integer("Monotonic lock generation."), "expiresInSeconds": integer()}, required=["lockToken", "generation", "expiresInSeconds"])}, required=["ok", "data"])),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("409", ERR["409"])])))

add("POST", "/api/files/{id}/lock/renew", operation("Renew a held edit lock", "Workflow", "renewLock", security=SESSION,
    params=[id_param("id", "File id.")],
    request={"application/json": {"schema": ref("LockTokenRequest")}},
    responses=dict([json_ok(obj({"renewed": string()}, required=["renewed"]), "Renewed file id."), resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("409", ERR["409"])])))

add("DELETE", "/api/files/{id}/lock", operation("Release a held edit lock", "Workflow", "releaseLock", security=SESSION,
    params=[id_param("id", "File id.")],
    request={"application/json": {"schema": ref("LockTokenRequest")}},
    responses=dict([json_ok(obj({"released": string()}, required=["released"]), "Released file id."), resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("409", ERR["409"])])))

add("GET", "/api/files/{id}/lock", operation("Lock status", "Workflow", "lockStatus", security=SESSION,
    params=[id_param("id", "File id.")],
    responses=dict([json_ok(ref("LockStatus"), "Lock state."), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

# --- Approvals ---
add("GET", "/api/approvals", operation("List approvals visible to the caller", "Workflow", "listApprovals", security=SESSION,
    params=[query("scope", "mine = requested by me; pending = awaiting my decision; empty = both.", {"type": "string", "enum": ["mine", "pending"]})],
    responses=dict([json_ok(arr(ref("Approval")), "Approvals."), resp("401", ERR["401"]), resp("403", ERR["403"])])))

add("POST", "/api/approvals/{id}/approve", operation("Approve a pending change", "Workflow", "approveApproval", security=SESSION,
    params=[id_param("id", "Approval id.")],
    request={"application/json": {"schema": ref("ApprovalDecisionRequest")}},
    responses=dict([json_ok(obj({"fileId": string(), "versionSeq": integer(), "sha256": string(), "status": {"type": "string", "enum": ["committed"]}}, required=["fileId", "versionSeq", "sha256", "status"]), "Approved content committed as a new version."),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("409", ERR["409"])])))

add("POST", "/api/approvals/{id}/reject", operation("Reject a pending change", "Workflow", "rejectApproval", security=SESSION,
    params=[id_param("id", "Approval id.")],
    request={"application/json": {"schema": ref("ApprovalDecisionRequest")}},
    responses=dict([json_ok(obj({"rejected": string()}, required=["rejected"]), "Rejected approval id; staged content discarded, current file untouched."),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("409", ERR["409"])])))

add("POST", "/api/approvals/{id}/cancel", operation("Cancel own pending approval", "Workflow", "cancelApproval", security=SESSION,
    params=[id_param("id", "Approval id.")],
    responses=dict([json_ok(obj({"cancelled": string()}, required=["cancelled"]), "Cancelled approval id."), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("409", ERR["409"])])))

add("GET", "/api/folders/{id}/approval-policy", operation("Read folder approval policy", "Workflow", "getApprovalPolicy", security=SESSION,
    params=[id_param("id", "Folder id.")],
    responses=dict([json_ok(ref("ApprovalPolicy"), "Policy state."), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

add("PUT", "/api/folders/{id}/approval-policy", operation("Set folder approval policy", "Workflow", "setApprovalPolicy", security=SESSION,
    params=[id_param("id", "Folder id.")],
    request={"application/json": {"schema": ref("SetApprovalPolicyRequest")}},
    responses=dict([json_ok(obj({"configured": {"type": "boolean", "enum": [True]}, "approverId": string(), "enabled": boolean()}, required=["configured", "approverId", "enabled"]), "Saved policy."),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

add("DELETE", "/api/folders/{id}/approval-policy", operation("Clear folder approval policy", "Workflow", "clearApprovalPolicy", security=SESSION,
    params=[id_param("id", "Folder id.")],
    responses=dict([json_ok(obj({"cleared": string()}, required=["cleared"]), "Cleared folder id."), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

# --- Office / DOCX ---
add("POST", "/api/files/{id}/office/session", operation("Open a DOCX editing session", "Office", "openOfficeSession", security=SESSION,
    params=[id_param("id", "File id.")],
    responses=dict([resp("201", "Editor session opened", obj({"ok": {"type": "boolean", "enum": [True]}, "data": ref("OfficeSession")}, required=["ok", "data"])),
                    resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("409", ERR["409"])])))

add("POST", "/api/files/{id}/office/session/{sid}/cancel", operation("Cancel an editing session", "Office", "cancelOfficeSession", security=SESSION,
    params=[id_param("id", "File id."), id_param("sid", "Session id.")],
    responses=dict([json_ok(obj({"cancelled": string()}, required=["cancelled"]), "Cancelled session id."), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

add("GET", "/api/internal/office/source/{token}", operation("Editor document source (token-authenticated)", "Office", "officeSource", security=SOURCE_TOKEN,
    params=[id_param("token", "Per-session source token."), query("token", "Token repeated as a query parameter for the document server.")],
    responses={"200": {"description": "Immutable DOCX bytes for the editor.", "content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}},
               "401": {"description": "Invalid or expired source token"}, "404": {"description": ERR["404"]}}))

add("POST", "/api/internal/office/callback", operation("Document server save callback", "Office", "officeCallback", security=OFFICE_JWT,
    request={"application/json": {"schema": ref("EditorCallback")}},
    responses={"200": {"description": "ONLYOFFICE command result envelope: {\"error\": 0} on success, {\"error\": <code>} on failure (always HTTP 200).",
                       "content": {"application/json": {"schema": obj({"error": integer()}, required=["error"])}}}}))

# --- CAD derivatives ---
add("POST", "/api/files/{id}/derivative", operation("Request a server-side conversion", "CAD", "requestDerivative", security=SESSION,
    params=[id_param("id", "File id.")],
    responses=dict([resp("202", "Conversion accepted", obj({"ok": {"type": "boolean", "enum": [True]}, "data": ref("Derivative")}, required=["ok", "data"])),
                    resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("409", ERR["409"])])))

add("GET", "/api/files/{id}/derivative", operation("Conversion status and format class", "CAD", "derivativeStatus", security=SESSION,
    params=[id_param("id", "File id.")],
    responses=dict([json_ok(ref("DerivativeStatus"), "Derivative state or format support facts."), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

add("GET", "/api/files/{id}/derivative/bytes", operation("Download converted derivative bytes", "CAD", "derivativeBytes", security=SESSION,
    params=[id_param("id", "File id.")],
    responses={"200": {"description": "Converted bytes (glTF/GLB or rendered output).",
                       "headers": {"X-Content-Sha256": {"schema": {"type": "string"}}},
                       "content": {"model/gltf-binary": {"schema": {"type": "string", "format": "binary"}}, "application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}},
               "401": {"description": ERR["401"]}, "403": {"description": ERR["403"]}, "404": {"description": ERR["404"]}}))

add("GET", "/api/formats/cad", operation("CAD format support matrix", "CAD", "formatMatrix", security=SESSION,
    responses=dict([json_ok(arr(ref("CadFormat")), "Per-format class, engine and note."), resp("401", ERR["401"])])))

# --- Collaboration ---
add("GET", "/api/shares", operation("List shares involving the caller", "Collaboration", "listShares", security=SESSION,
    params=[query("scope", "mine = created by me; tome = targeting me; empty = both.", {"type": "string", "enum": ["mine", "tome"]})],
    responses=dict([json_ok(arr(ref("Share")), "Shares."), resp("401", ERR["401"]), resp("403", ERR["403"])])))

add("POST", "/api/shares", operation("Share a file or folder", "Collaboration", "createShare", security=SESSION,
    request={"application/json": {"schema": ref("CreateShareRequest")}},
    responses=dict([resp("201", "Share created", obj({"ok": {"type": "boolean", "enum": [True]}, "data": ref("Share")}, required=["ok", "data"])),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("409", ERR["409"])])))

add("DELETE", "/api/shares/{id}", operation("Revoke a share", "Collaboration", "revokeShare", security=SESSION,
    params=[id_param("id", "Share id.")],
    responses=dict([json_ok(obj({"revoked": string()}, required=["revoked"]), "Revoked share id."), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

# WF-21: the share wizard's recipient picker. Any authenticated caller may read
# it (a share only needs the recipient to exist), but it stays a minimal read:
# id + display label only, disabled accounts excluded, hard-capped at 200.
add("GET", "/api/share-recipients", operation("List share recipients (minimal picker read)", "Collaboration", "shareRecipients", security=SESSION,
    params=[query("kind", "Recipient kind; user rows carry {id,displayName}, group rows {id,name}.", {"type": "string", "enum": ["user", "group"]}, required=True),
            query("q", "Case-insensitive display-name fragment."),
            query("limit", "Page size; defaults to 50 and is capped at 200.", {"type": "integer", "minimum": 1, "maximum": 200})],
    responses=dict([json_ok(ref("ShareRecipientPage"), "Minimal recipient rows for the requested kind; disabled accounts are excluded."),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"])]),
    auth_note=MUST_CHANGE))

add("GET", "/api/favorites", operation("List favorites", "Collaboration", "listFavorites", security=SESSION,
    responses=dict([json_ok(arr(ref("Favorite")), "Favorites of the caller."), resp("401", ERR["401"]), resp("403", ERR["403"])])))

add("PUT", "/api/favorites/{kind}/{id}", operation("Add a favorite", "Collaboration", "setFavoriteOn", security=SESSION,
    params=[{"name": "kind", "in": "path", "required": True, "schema": {"type": "string", "enum": ["file", "folder"]}, "description": "Resource kind."}, id_param("id", "Resource id.")],
    responses=dict([json_ok(obj({"id": string(), "favorited": {"type": "boolean", "enum": [True]}}, required=["id", "favorited"]), "Favorited."), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

add("DELETE", "/api/favorites/{kind}/{id}", operation("Remove a favorite", "Collaboration", "setFavoriteOff", security=SESSION,
    params=[{"name": "kind", "in": "path", "required": True, "schema": {"type": "string", "enum": ["file", "folder"]}, "description": "Resource kind."}, id_param("id", "Resource id.")],
    responses=dict([json_ok(obj({"id": string(), "favorited": {"type": "boolean", "enum": [False]}}, required=["id", "favorited"]), "Removed."), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

# --- Search / stats / export ---
SEARCH_PARAMS = [
    query("q", "Search query; CJK text is tokenized per character."),
    query("folder", "Restrict to one authorized folder."),
    query("scope", "descendants includes child folders.", {"type": "string", "enum": ["", "descendants"]}),
    query("uploader", "Filter by uploader id."),
    query("type", "Filter by content-type prefix."),
    query("sort", "Sort key (search/stats/export accept only these; anything else is 400 E_BAD).", {"type": "string", "enum": ["updated_desc", "name_asc", "size_desc"]}),
    query("limit", "Page size.", {"type": "integer", "minimum": 1, "maximum": 200}),
    query("from", "Lower bound on updatedAt (RFC3339).", {"type": "string", "format": "date-time"}),
    query("to", "Upper bound on updatedAt (RFC3339).", {"type": "string", "format": "date-time"}),
]

add("GET", "/api/search", operation("Full-text search over authorized files", "Search", "searchFiles", security=SESSION,
    params=SEARCH_PARAMS + [query("cursor", "Opaque keyset cursor from nextCursor; an unparseable value restarts at the first page instead of failing the read (WF-30).")],
    responses=dict([json_ok(ref("SearchResult"), "Authorized matches with snippets, the authorized total and the cursor for the next page."), resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"])])))

add("GET", "/api/stats", operation("Aggregate statistics over authorized files", "Search", "statsFiles", security=SESSION,
    params=SEARCH_PARAMS,
    responses=dict([json_ok(ref("Stats"), "Counts by type, month and uploader."), resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"])])))

add("GET", "/api/exports/files.csv", operation("Stream authorized CSV export", "Search", "exportFiles", security=SESSION,
    params=SEARCH_PARAMS,
    responses={"200": {"description": "UTF-8 CSV with BOM; rows stream as the scan progresses.",
                       "headers": {"Content-Disposition": {"schema": {"type": "string"}, "description": "attachment; filename=\"files.csv\""}},
                       "content": {"text/csv": {"schema": {"type": "string"}}}},
               "401": {"description": ERR["401"]}, "403": {"description": ERR["403"]}}))

# --- Trash ---
add("GET", "/api/trash", operation("List trash entries visible to the caller", "Trash", "listTrash", security=SESSION,
    responses=dict([json_ok(arr(ref("TrashEntry")), "Trash entries."), resp("401", ERR["401"]), resp("403", ERR["403"])])))

add("POST", "/api/trash/{id}/restore", operation("Restore a trash entry", "Trash", "restoreTrash", security=SESSION,
    params=[id_param("id", "Trash entry id.")],
    request={"application/json": {"schema": ref("RestoreTrashRequest")}},
    responses=dict([json_ok(ref("TrashEntry"), "Restored entry."), resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("409", ERR["409"])])))

add("DELETE", "/api/trash/{id}", operation("Permanently purge a trash entry", "Trash", "purgeTrash", security=SESSION,
    params=[id_param("id", "Trash entry id.")],
    responses=dict([json_ok(obj({"purged": string()}, required=["purged"]), "Purged trash id."), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))

# --------------------------------------------------------------------------
# Document assembly
# --------------------------------------------------------------------------


def build():
    paths = {}
    for method, path, op in ROUTES:
        # gin path params -> OpenAPI path params
        spec_path = path
        segments = []
        for seg in path.split("/"):
            if seg.startswith(":"):
                seg = "{" + seg[1:] + "}"
            segments.append(seg)
        spec_path = "/".join(segments)
        paths.setdefault(spec_path, {})[method.lower()] = op

    # Every error response carries the SPEC 5.3 envelope so clients can code
    # against one shape; responses that already declare content keep theirs.
    for item in paths.values():
        for op in item.values():
            for code, response in op["responses"].items():
                if code.isdigit() and int(code) >= 400 and "content" not in response:
                    response["content"] = {"application/json": {"schema": ref("ErrorEnvelope")}}

    operation_ids = [op["operationId"] for _, _, op in ROUTES]
    assert len(operation_ids) == len(set(operation_ids)), "duplicate operationId: " + str(
        [oid for oid in operation_ids if operation_ids.count(oid) > 1])

    return {
        "openapi": "3.0.3",
        "info": {
            "title": "filesmanage v2.1 implemented API",
            "version": "2.1.0",
            "description": (
                "Contract for the implemented filesmanage v2.1 HTTP surface, generated by\n"
                "scripts/gen_openapi.py from internal/httpx/router.go and the handler payload\n"
                "builders. Served only from the isolated target host on 127.0.0.1:18091.\n\n"
                "Conventions:\n"
                "- Success responses are `{\"ok\": true, \"data\": ...}`; failures are\n"
                "  `{\"ok\": false, \"error\": {\"code\": \"E_...\"}}` with stable SPEC 5.3 codes.\n"
                "- Authentication is the HttpOnly `fm_session` cookie (SameSite=Strict).\n"
                "- Mutating requests require an Origin header matching the Host when sent by a\n"
                "  browser (E_ORIGIN otherwise).\n"
                "- Issued account credentials can be used at first login; changing passwords\n"
                "  remains available but is not mandatory.\n"
                "- Admin-only capability (user/department/workgroup management) is enforced in\n"
                "  the application layer and answers 403 E_FORBIDDEN for non-admins.\n"
                "- Socket peers outside FILESMANAGE_LAN_ALLOW_CIDRS are refused with 403\n"
                "  E_NETWORK before routing."
            ),
        },
        "servers": [{"url": "http://127.0.0.1:18091", "description": "Isolated development instance (target host)"}],
        "paths": paths,
        "components": {
            "securitySchemes": {
                "cookieSession": {
                    "type": "apiKey",
                    "in": "cookie",
                    "name": "fm_session",
                    "description": "HttpOnly session cookie issued by POST /api/login.",
                },
                "officeJWT": {
                    "type": "http",
                    "scheme": "bearer",
                    "description": "Document-server JWT presented by ONLYOFFICE on save callbacks.",
                },
                "officeSourceToken": {
                    "type": "apiKey",
                    "in": "query",
                    "name": "token",
                    "description": "Per-session source token embedded in the editor document URL.",
                },
            },
            "schemas": SCHEMAS,
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=OUT_DEFAULT, help="output YAML path")
    parser.add_argument("--check", action="store_true", help="fail if the output file differs from the generated document")
    args = parser.parse_args()

    doc = build()
    text = yaml.dump(doc, Dumper=NoAliasDumper, sort_keys=False, allow_unicode=True, width=120)

    if args.check:
        with open(args.out, encoding="utf-8") as handle:
            current = handle.read()
        if current != text:
            print("openapi drift: %s is stale; re-run scripts/gen_openapi.py" % args.out, file=sys.stderr)
            return 1
        print("openapi contract up to date (%d paths)" % len(doc["paths"]))
        return 0

    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write(text)
    print("wrote %s (%d paths, %d operations, %d schemas)" % (
        args.out, len(doc["paths"]), len(ROUTES), len(SCHEMAS)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
