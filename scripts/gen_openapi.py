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

schema("FileBusinessMetadata", obj({
    "fileId": string(), "category": string(), "description": string(),
    "tags": arr(string()), "updatedBy": string(), "updatedAt": timestamp(),
}, required=["fileId","category","description","tags","updatedBy","updatedAt"]))
schema("UpdateFileBusinessMetadata", obj({
    "category": string(max_length=80), "description": string(max_length=2000),
    "tags": arr(string()),
}, required=["category","description","tags"]))

schema("VersionComparisonLine",obj({
 "kind":string(enum=["equal","added","removed"]), "left":integer(), "right":integer(), "text":string(),
},required=["kind","text"]))
schema("VersionCompareInfo",obj({"seq":integer(),"sha256":string(),"sizeBytes":integer()},required=["seq","sha256","sizeBytes"]))
schema("OfficeSemanticChange",obj({
 "kind":string(enum=["added","removed","changed"]),
 "section":string(),"key":string(),"before":string(),"after":string()
},required=["kind","section","key","before","after"]))
schema("VersionComparison",obj({
 "left":ref("VersionCompareInfo"),"right":ref("VersionCompareInfo"),
 "mode":string(enum=["identical","metadata","large","text"]),
 "detail":string(enum=["office_parts","office_semantic"]),
 "semanticChanges":arr(ref("OfficeSemanticChange")),
 "lines":arr(ref("VersionComparisonLine")),"added":integer(),"removed":integer(),
},required=["left","right","mode","lines","added","removed"]))
schema("ReviewComment",obj({
 "id":integer(),"fileId":string(),"versionSeq":integer(),"pageNumber":integer(),"lineNumber":integer(),
 "body":string(),"authorId":string(),"authorName":string(),"creatorId":string(),"creatorName":string(),
 "assigneeId":string(),"assigneeName":string(),"revision":integer(minimum=0),
 "status":string(enum=["open","assigned","pending_approval","approved","completed_self","rejected"]),
 "resolutionNote":string(),"resolvedVersionSeq":integer(),"approvalNote":string(),"approvedAt":timestamp(),
 "resolvedAt":timestamp(),"resolvedBy":string(),"resolvedByName":string(),"createdAt":timestamp(),
},required=["id","fileId","versionSeq","body","authorId","createdAt"]))
schema("ReviewCounts",obj({"all":integer(),"mine":integer(),"approval":integer(),"done":integer()},required=["all","mine","approval","done"]))
schema("ReviewCommentPage",obj({"items":arr(ref("ReviewComment")),"nextCursor":string(),"counts":ref("ReviewCounts")},required=["items","nextCursor","counts"]))
schema("ReviewEvent",obj({
 "id":integer(),"actorId":string(),"actorName":string(),"kind":string(),"createdAt":timestamp(),
 "statusBefore":string(),"statusAfter":string(),"assigneeId":string(),"assigneeName":string(),
 "resolvedBy":string(),"resolvedByName":string(),"resolutionNote":string(),"resolvedVersionSeq":integer(),
 "approvalNote":string(),
},required=["id","actorId","actorName","kind","createdAt","statusBefore","statusAfter"]))
schema("CreateReviewComment",obj({
 "version":integer(),"versionSeq":integer(minimum=1),"pageNumber":integer(minimum=1),
 "lineNumber":integer(),"assigneeId":string(),"body":string(max_length=2000),
},required=["body"]))
schema("ReviewTransition",obj({
 "assigneeId":string(),"resolutionNote":string(max_length=3000),
 "resolvedVersionSeq":integer(minimum=1),"approvalNote":string(max_length=3000),
}))
schema("ReviewAssignee",obj({"id":string(),"displayName":string(),"departmentName":string(),"role":string()},required=["id","displayName","role"]))
schema("ReviewNotification",obj({
 "id":integer(),"reviewId":integer(),"fileId":string(),"fileName":string(),
 "kind":string(),"createdAt":timestamp(),"read":boolean(),
},required=["id","reviewId","fileId","fileName","kind","createdAt","read"]))
schema("ReviewNotificationPage",obj({
 "items":arr(ref("ReviewNotification")),"unreadCount":integer(minimum=0),
},required=["items","unreadCount"]))

schema("ResumableStatus",obj({
 "id":string(),"received":integer(),"size":integer(),"state":string(enum=["open","committed","cancelled"]),
 "expiresAt":timestamp(),"result":obj({"fileId":string(),"versionSeq":integer(),"sha256":string(),"size":integer(),"name":string(),"folderId":string(),"dedup":boolean()}),
},required=["id","received","size","state","expiresAt"]))
schema("ResumableStart",obj({"folderId":string(),"name":string(),"size":integer(minimum=1),
 "contentType":string(),"idempotencyKey":string(),"sha256":string()},required=["folderId","name","size","idempotencyKey"]))

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
    "oldParentPath": string("Deletion-time folder path, shown only to the deleting actor when a snapshot exists."),
    "oldParentTrail": arr(obj({"id": string(), "name": string()}, required=["id", "name"]), "Deletion-time ancestor identities and names; absent for legacy rows or other viewers."),
    "subtreeCount": integer("Folders swept into the trash entry."),
}, required=["id", "oldName", "deletedBy", "deletedByName", "deletedAt"]))

schema("ApprovalEvent", obj({
 "id":integer(),"approvalId":string(),"actorId":string(),"actorName":string(),
 "kind":string(enum=["submitted","advanced","approved","rejected","cancelled","conflicted"]),
 "stepIndex":integer(),"comment":string(),"createdAt":timestamp(),
},required=["id","approvalId","actorId","actorName","kind","stepIndex","comment","createdAt"]))
schema("ApprovalNotification", obj({
 "id":integer(),"approvalId":string(),"fileName":string(),
 "kind":string(enum=["submitted","advanced","approved","rejected","cancelled","conflicted"]),
 "stepIndex":integer(),"createdAt":timestamp(),"read":boolean(),
},required=["id","approvalId","fileName","kind","stepIndex","createdAt","read"]))

schema("Approval", obj({
    "id": string(),
    "fileId": string(),
    "fileName": string(),
    "requesterId": string(),
    "requesterName": string(),
    "approverId": string(),
    "approverName": string(),
    "approverIds":arr(string()),"stepIndex":integer(),"stepTotal":integer(),
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
    "unavailable": boolean("Legacy alias for status != active; never discloses delete state."),
    "status": string(enum=["active","trashed","inaccessible"]),
    "trashEntryId": string("Visible only when current user is authorized to inspect the direct trash entry."),
    "capabilities": obj({"open": boolean(), "share": boolean(), "unfavorite": boolean()}),
    "createdAt": timestamp(),
    "fileId": string("Present for file favorites."),
    "folderId": string("Present for folder favorites."),
    "kind": string(enum=["file", "folder"]),
}, required=["id", "resourceName", "unavailable", "createdAt"]))

schema("FavoriteChangeNotification", obj({
    "id": integer(),
    "affectedCount": integer("How many of the recipient's own favorites were affected."),
    "createdAt": timestamp(),
    "read": boolean(),
}, required=["id","affectedCount","createdAt","read"]))

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
    "class": string(enum=["native", "converted", "licensed", "unverified", "invalid"]),
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
    "approverIds":arr(string(),desc="Ordered approval chain (1-5 people)."),
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

schema("SetApprovalPolicyRequest", obj({"approverId": string(), "approverIds":arr(string()), "enabled": boolean()}, required=["enabled"]))

schema("CreateShareRequest", obj({
    "resourceKind": string(enum=["file", "folder"]),
    "resourceId": string(),
    "recipientKind": string(enum=["user", "group"]),
    "recipientId": string(),
    "actions": arr(string(enum=SHARE_ACTIONS)),
    "includeDescendants": boolean("Folder shares only."),
    "expiresAt": timestamp(),
}, required=["resourceKind", "resourceId", "recipientKind", "recipientId", "actions"]))

schema("RestoreTrashRequest", obj({"destinationFolderId": string("Restore target; empty keeps the original parent."), "newName": string("Rename on restore; empty keeps the old name."),
    "confirmDestination": boolean("Explicit target selection required when original ancestry has changed since deletion.")}))

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

# --- CDW task kernel (single-file pilot) ---
CDW_ASSIGNEE = obj({"kind": string(enum=["user","workgroup"]), "id": string()},required=["kind","id"])
CDW_TASK_RESULT = obj({
    "taskId": string(), "parentTaskId": string(), "parentRevision": integer(minimum=1), "state": string(),
    "revision": integer(minimum=1), "assignmentId": string(),
    "actualAcceptorId": string(), "remainingObligations": arr(string()),
}, required=["taskId","state","revision","assignmentId"])
CDW_SCOPE_INBOX = obj({"items": arr(obj({
    "kind": string(enum=["task","obligation"]), "taskId": string(), "title": string(),
    "fileId": string(), "state": string(), "revision": integer(minimum=1),
    "assignmentId": string(), "obligationId": string(), "obligationKind": string(),
})), "asOf": timestamp(), "nextCursor": {"type":"string","nullable":True}},required=["items","asOf","nextCursor"])
CDW_IDEMPOTENCY = {"name":"Idempotency-Key","in":"header","required":True,
 "description":"8-128 ASCII letters, digits, hyphens or underscores; same key+body exactly replays the committed result.",
 "schema":string(max_length=128)}
CDW_IF_MATCH = {"name":"If-Match","in":"header","required":True,
 "description":"Strong ETag rev-N enclosed in double quotes.","schema":string()}
CDW_ROOT = obj({"title":string(max_length=255),"fileId":string(),"templateVersionId":string("Optional; built-in single-file task template when omitted."),"assignee":CDW_ASSIGNEE,"allowOverrideReview":{"type":"boolean","description":"Administrator opt-in creates published single-file template version allowing gate-specific override; defaults false."}},
 required=["title","fileId","assignee"])
CDW_CHILD = obj({"childTitle":string(max_length=255),"assignee":CDW_ASSIGNEE},
 required=["childTitle","assignee"])
add("POST","/api/workbench/tasks",operation("Create single-file root work task (administrator only)","CDW","cdwCreateRoot",
 security=SESSION,params=[CDW_IDEMPOTENCY],
 request={"application/json":{"schema":CDW_ROOT}},
 responses={"201":{"description":"Created with rev-1 ETag","content":{"application/json":{"schema":obj({"ok":{"type":"boolean"},"data":CDW_TASK_RESULT},required=["ok","data"])}}},
 "400":{"description":"Invalid input or missing idempotency key"},"403":{"description":"Insufficient access"},"409":{"description":"Conflict"}}))
add("GET","/api/workbench/inbox",operation("Authorized CDW task and accountability inbox","CDW","cdwInbox",
 security=SESSION,params=[query("limit","Requested rows (1..100).",{"type":"integer","minimum":1,"maximum":100})],
 responses=dict([json_ok(CDW_SCOPE_INBOX,"Authorized current rows; nextCursor null until cursor paging is implemented."),
 resp("400",ERR["400"]),resp("401",ERR["401"])])))
CDW_INITIATED_PAGE = obj({"items":arr(obj({
 "taskId":string(),"rootId":string(),"parentId":string(),"title":string(),"fileId":string(),
 "state":string(),"revision":integer(minimum=1),"createdAt":timestamp(),"assigneeName":string(),
},required=["taskId","rootId","title","fileId","state","revision","createdAt"])),
 "nextCursor":string("Opaque creator-scoped task cursor; absent on the last page.")},required=["items"])
add("GET","/api/workbench/initiated",operation("Track work actually started by this user, including delegated and ended tasks","CDW","cdwInitiated",
 security=SESSION,params=[query("limit","Requested raw rows (1..100). Defaults to 30.",{"type":"integer","minimum":1,"maximum":100}),
 query("cursor","Opaque task ID from previous page; scoped to the current creator.",string(max_length=256))],
 responses=dict([json_ok(CDW_INITIATED_PAGE,"Author-scoped keyset page, further filtered by current file preview ACL; the number of visible items may be lower than the raw page size."),
 resp("400",ERR["400"]),resp("401",ERR["401"])])))
CDW_TRACE_PAGE=obj({"items":arr(obj({
 "id":integer(minimum=1),"kind":string(),"evidenceRef":string(),"event":string(),
 "actorName":string(),"occurredAt":timestamp(),
},required=["id","kind","evidenceRef","event","actorName","occurredAt"])),
 "nextBefore":integer(minimum=1)},required=["items"])
add("GET","/api/workbench/initiated/{id}/events",operation("Immutable task, branch, review and responsibility facts for the current creator","CDW","cdwInitiatedEvents",
 security=SESSION,params=[id_param("id","Author-owned work ID."),
 query("limit","Requested event rows (1..100). Defaults to 30.",{"type":"integer","minimum":1,"maximum":100}),
 query("before","Earlier event ID cursor, positive integer.",{"type":"integer","minimum":1})],
 responses=dict([json_ok(CDW_TRACE_PAGE,"Immutable audit identifiers, event kind, actor name and exact time without exposing raw event payloads."),
 resp("400",ERR["400"]),resp("401",ERR["401"]),resp("404",ERR["404"])])))
CDW_WORK_FLOW = obj({
 "taskId":string(),"rootId":string(),"truncated":{"type":"boolean"},
 "works":arr(obj({"id":string(),"parentId":string(),"title":string(),"state":string(),
  "round":integer(minimum=1),"responsibleName":string(),"createdByName":string()},
  required=["id","title","state","round","createdByName"])),
 "milestones":arr(obj({"taskId":string(),"kind":string(),"reference":string(),"state":string(),
  "round":integer(minimum=1),"actorName":string(),"recordedAt":timestamp(),"detail":string()},
  required=["taskId","kind","reference","state","recordedAt"])),
},required=["taskId","rootId","truncated","works","milestones"])
add("GET","/api/workbench/dhf/projects/{id}/work-links",operation("Creator-scoped related CDW work for DHF pinned files","DHF","dhfRelatedWorks",security=SESSION,params=[id_param("id","Authorized DHF project ID")],responses=dict([json_ok(obj({"items":arr(obj({"taskId":string(),"sourceLine":integer(),"stageNo":integer(),"title":string(),"state":string(),"assigneeName":string(),"exactDeliveryMatch":{"type":"boolean"}})),"truncated":{"type":"boolean"}}),"Read-only file identity and exact delivery SHA-256 matching"),resp("401",ERR["401"]),resp("404",ERR["404"])])))
add("GET","/api/workbench/initiated/{id}/flow",operation(
 "Creator-scoped delegation subtree and exact-delivery controlled-document milestone evidence",
 "CDW","cdwInitiatedFlow",security=SESSION,params=[id_param("id","Task authored by the signed-in user.")],
 responses=dict([json_ok(CDW_WORK_FLOW,"Live readonly facts. Missing milestones never imply completion. Release and receipt evidence is linked through exact frozen delivery and artifact."),
 resp("401",ERR["401"]),resp("404",ERR["404"])])))
add("POST","/api/workbench/tasks/{id}/accept",operation("Accept a task as its active assignee or current workgroup leader","CDW","cdwAccept",
 security=SESSION,params=[id_param("id","Task ID."),CDW_IDEMPOTENCY,CDW_IF_MATCH],
 request={"application/json":{"schema":obj({})}},
 responses=dict([json_ok(CDW_TASK_RESULT,"Accepted with new strong ETag."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("POST","/api/workbench/tasks/{id}/delegate",operation("Create child task retaining parent accountability","CDW","cdwDelegate",
 security=SESSION,params=[id_param("id","Parent task ID."),CDW_IDEMPOTENCY,CDW_IF_MATCH],
 request={"application/json":{"schema":CDW_CHILD}},
 responses={"201":{"description":"Child assigned; parent obligations stay pending",
 "content":{"application/json":{"schema":obj({"ok":{"type":"boolean"},"data":CDW_TASK_RESULT},required=["ok","data"])}}},
 "403":{"description":"Not the accepted active assignee"},"409":{"description":"Conflict"}}))

# --- CDW branch/ONLYOFFICE delivery fence (single-file pilot) ---
CDW_BRANCH_CREATE = obj({"taskId":string()},required=["taskId"])
CDW_BRANCH = obj({
 "branchId":string(),"taskId":string(),"fileId":string(),
 "baseVersionId":string(),"baseSha256":string(),"state":string(),
 "revision":integer(minimum=1),"headRevisionId":string(),"editEpoch":integer(minimum=1)
},required=["branchId","taskId","fileId","baseVersionId","baseSha256","state","revision","editEpoch"])
CDW_SAVE_REQ = obj({"sessionId":string()},required=["sessionId"])
CDW_SAVE_STATUS = obj({
 "requestId":string(),"branchId":string(),"sessionId":string(),
 "state":string(enum=["requested","accepted","unknown","persisted","failed"]),
 "persistedRevisionId":string(),"sha256":string(),
 "generation":integer(minimum=1),"editEpoch":integer(minimum=1)
},required=["requestId","branchId","sessionId","state","generation","editEpoch"])
CDW_FREEZE_REQ = obj({"requestId":string(),"branchRevisionId":string()},
 required=["requestId","branchRevisionId"])
CDW_FREEZE = obj({"deliveryId":string(),"branchId":string(),"taskId":string(),
 "branchRevisionId":string(),"sha256":string(),"reviewGateId":string(),
 "revision":integer(minimum=1)},
 required=["deliveryId","branchId","taskId","branchRevisionId","sha256","reviewGateId","revision"])
add("POST","/api/work-branches",operation("Create isolated task editing branch; no file_versions mutation","CDW","cdwCreateBranch",
 security=SESSION,params=[CDW_IDEMPOTENCY],request={"application/json":{"schema":CDW_BRANCH_CREATE}},
 responses=dict([json_ok(CDW_BRANCH,"New branch created."),resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("GET","/api/work-branches/{id}",operation("Current authorized work branch","CDW","cdwReadBranch",
 security=SESSION,params=[id_param("id","Branch ID.")],
 responses=dict([json_ok(CDW_BRANCH,"Live branch head and edit epoch."),resp("403",ERR["403"])])))
add("GET","/api/workbench/tasks/{id}/branches",operation("Authorized task branches","CDW","cdwTaskBranches",
 security=SESSION,params=[id_param("id","Task ID.")],
 responses=dict([json_ok(obj({"items":arr(CDW_BRANCH)},required=["items"]),"Branches visible to accepted assignee."),resp("403",ERR["403"])])))
add("POST","/api/work-branches/{id}/office-sessions",operation("Open exclusive ONLYOFFICE document key for a task branch","CDW","cdwBranchOffice",
 security=SESSION,params=[id_param("id","Branch ID.")],
 request={"application/json":{"schema":obj({})}},
 responses=dict([json_ok(obj({"branch":CDW_BRANCH,"session":{"type":"object"},"editorUrl":string(),"config":{"type":"object"}}),
 "ONLYOFFICE editor config signed; callback/source use branch-only routes."),resp("409",ERR["409"])])))
add("POST","/api/work-branches/{id}/office-sessions/{sessionId}/heartbeat",operation("Renew the live exclusively owned branch editor lease","CDW","cdwHeartbeatBranchOffice",
 security=SESSION,params=[id_param("id","Branch ID."),id_param("sessionId","Owned active Office session ID.")],
 request={"application/json":{"schema":obj({})}},
 responses=dict([json_ok(obj({"sessionId":string(),"branchId":string(),"expiresAt":timestamp()},required=["sessionId","branchId","expiresAt"]),"Active lease extended, expired/fenced leases cannot revive."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("POST","/api/work-branches/{id}/save",operation("Request final ONLYOFFICE save; acknowledgement is NOT persistence","CDW","cdwBranchSave",
 security=SESSION,params=[id_param("id","Branch ID."),CDW_IDEMPOTENCY],request={"application/json":{"schema":CDW_SAVE_REQ}},
 responses={"202":{"description":"Requested/unknown: poll matching callback receipt; cannot freeze yet",
 "content":{"application/json":{"schema":obj({"ok":{"type":"boolean"},"data":CDW_SAVE_STATUS},required=["ok","data"])}}},
 "409":{"description":"Invalid/duplicate active save request"}}))
add("GET","/api/work-branches/{id}/save-requests/{rid}",operation("Read authoritative scoped branch-save receipt","CDW","cdwBranchSaveStatus",
 security=SESSION,params=[id_param("id","Branch ID."),id_param("rid","Save request ID.")],
 responses=dict([json_ok(CDW_SAVE_STATUS,"Persisted only after callback commits exact blob/revision."),resp("403",ERR["403"])])))
add("POST","/api/work-branches/{id}/freeze-delivery",operation("Freeze exact committed branch revision into immutable delivery","CDW","cdwBranchFreeze",
 security=SESSION,params=[id_param("id","Branch ID."),CDW_IDEMPOTENCY,CDW_IF_MATCH],
 request={"application/json":{"schema":CDW_FREEZE_REQ}},
 responses={"201":{"description":"Committed immutable delivery, first direct-parent gate awaiting review",
 "content":{"application/json":{"schema":obj({"ok":{"type":"boolean"},"data":CDW_FREEZE},required=["ok","data"])}}},
 "409":{"description":"Save pending, stale ETag, or branch frozen"}}))
add("GET","/api/internal/office/branch-source/{token}",operation("Signed branch-only ONLYOFFICE document snapshot","CDW","cdwOfficeBranchSource",
 security=[],params=[id_param("token","Short-lived scoped editor JWT.")],
 responses={"200":{"description":"OOXML bytes, only if session and branch remain live"},
 "401":{"description":"Invalid source capability"}}))
add("POST","/api/internal/office/branch-callback",operation("JWT-authenticated ONLYOFFICE branch-save callback","CDW","cdwOfficeBranchCallback",
 security=[],request={"application/json":{"schema":obj({
 "key":string(),"status":integer(),"url":string(),"userdata":string(),"forcesavetype":integer()
 },required=["key","status"])}},
 responses={"200":{"description":"ONLYOFFICE acknowledgement: error 0 or 1; never updates file_versions"}}))

# --- CDW direct-parent review, return and content-continuity ---
CDW_REVIEW_GATE=obj({
 "gateId":string(),"deliveryId":string(),"taskId":string(),"taskTitle":string(),
 "fileId":string(),"submittedBy":string(),"reviewerId":string(),
 "branchRevisionId":string(),"sha256":string(),"state":string(),
 "revision":integer(minimum=1),"round":integer(minimum=1),
 "substitutable":{"type":"boolean"},"overrideGrantId":string(),"reviewMode":string(enum=["direct","delegated"])
},required=["gateId","deliveryId","taskId","taskTitle","fileId","submittedBy","reviewerId","branchRevisionId","sha256","state","revision","round","substitutable","reviewMode"])
CDW_REVIEW_DECISION=obj({"decision":string(enum=["accept","return"]),"reason":string(max_length=3000),"overrideGrantId":string("Required and exact when acting under delegated review authority.")},
 required=["decision"])
CDW_REVIEW_RESULT=obj({"gateId":string(),"deliveryId":string(),"taskId":string(),"state":string(),
 "taskState":string(),"revision":integer(minimum=1),"round":integer(minimum=1),"returnOrderId":string(),"actingForId":string(),"overrideGrantId":string()},
 required=["gateId","deliveryId","taskId","state","taskState","revision","round"])
CDW_RESUME_RESULT=obj({"taskId":string(),"branchId":string(),"revision":integer(minimum=1),
 "round":integer(minimum=1),"state":string()},required=["taskId","branchId","revision","round","state"])
add("GET","/api/workbench/review-gates/inbox",operation("Review gates addressed to actual direct reviewer","CDW","cdwReviewInbox",
 security=SESSION,params=[query("limit","1..100",{"type":"integer","minimum":1,"maximum":100})],
 responses=dict([json_ok(obj({"items":arr(CDW_REVIEW_GATE)},required=["items"]),"Direct reviewer awaiting gates with live ACL."),
 resp("401",ERR["401"])])))
add("GET","/api/workbench/review-gates/{id}",operation("Read exact frozen delivery gate","CDW","cdwReviewDetail",
 security=SESSION,params=[id_param("id","Review gate ID.")],
 responses=dict([json_ok(CDW_REVIEW_GATE,"SHA bound delivery gate, reviewer only."),
 resp("403",ERR["403"])])))
add("POST","/api/workbench/review-gates/{id}/decide",operation("Accept or return immutable delivery; never formally approve file","CDW","cdwReviewDecide",
 security=SESSION,params=[id_param("id","Review gate ID."),CDW_IDEMPOTENCY,CDW_IF_MATCH],
 request={"application/json":{"schema":CDW_REVIEW_DECISION}},
 responses=dict([json_ok(CDW_REVIEW_RESULT,"Decision committed; obligations remain independent."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
CDW_OVERRIDE_GRANT=obj({
 "grantId":string(),"gateId":string(),"taskId":string(),"grantedBy":string(),
 "actorId":string(),"expiresAt":timestamp(),"revoked":{"type":"boolean"}
},required=["grantId","gateId","taskId","grantedBy","actorId","expiresAt","revoked"])
add("GET","/api/workbench/review-gates/{id}/candidates",operation("File-authorized upper task-chain reviewers eligible for a gate-specific grant","CDW","cdwReviewCandidates",
 security=SESSION,params=[id_param("id","Review gate ID.")],
 responses=dict([json_ok(obj({"items":arr(obj({"id":string(),"displayName":string()},required=["id","displayName"]))},required=["items"]),"Only accepted active ancestors above direct parent, filtered by file ACL."),resp("403",ERR["403"])])))
add("GET","/api/workbench/review-gates/{id}/grants",operation("List grants for a gate (original direct reviewer only)","CDW","cdwReviewGrants",
 security=SESSION,params=[id_param("id","Review gate ID.")],
 responses=dict([json_ok(obj({"items":arr(CDW_OVERRIDE_GRANT)},required=["items"]),"All gate-bound grants including revoked evidence."),resp("403",ERR["403"])])))
add("POST","/api/workbench/review-gates/{id}/grants",operation("Issue one-day gate-specific substitute-review authorization from original reviewer to accepted ancestor","CDW","cdwReviewGrant",
 security=SESSION,params=[id_param("id","Review gate ID."),CDW_IDEMPOTENCY,CDW_IF_MATCH],
 request={"application/json":{"schema":obj({"actorId":string(),"reason":string(max_length=1000)},required=["actorId","reason"])}},
 responses=dict([json_ok(CDW_OVERRIDE_GRANT,"Granted with immutable actor/task/gate/expiry scope, not a formal approval."),resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("POST","/api/workbench/review-gates/{id}/grants/{grantId}/revoke",operation("Revoke a substitute review grant by its original issuer","CDW","cdwReviewRevoke",
 security=SESSION,params=[id_param("id","Review gate ID."),id_param("grantId","Grant ID."),CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({})}},
 responses=dict([json_ok(CDW_OVERRIDE_GRANT,"Revoked atomically and preserved as history."),resp("403",ERR["403"])])))
add("POST","/api/workbench/tasks/{id}/resume",operation("Rework a returned task with cloned frozen content and next round","CDW","cdwResumeReturned",
 security=SESSION,params=[id_param("id","Task ID."),CDW_IDEMPOTENCY,CDW_IF_MATCH],
 request={"application/json":{"schema":obj({})}},
 responses={"201":{"description":"New round and independent editable branch seeded from returned frozen revision.",
 "content":{"application/json":{"schema":obj({"ok":{"type":"boolean"},"data":CDW_RESUME_RESULT},required=["ok","data"])}}},
 "403":{"description":"Not current assignee"},"409":{"description":"Stale task revision or not returned"}}))

add("GET","/api/workbench/review-gates/{id}/content",operation("Download exact immutable reviewed DOCX","CDW","cdwReviewContent",
 security=SESSION,params=[id_param("id","Review gate ID.")],
 responses={"200":{"description":"Frozen delivery DOCX, only for actual reviewer (not current formal version)"},
 "403":{"description":"Not the direct reviewer"}}))

# --- G7 formal document approvals (not task gate acceptance or activation) ---
CDW_FORMAL_STEP = obj({"nodeKey":string(),"sequence":integer(minimum=1),"approverId":string()},
 required=["nodeKey","sequence","approverId"])
CDW_FORMAL_APPROVAL = obj({
 "id":string(),"subjectId":string(),"deliveryId":string(),"fileId":string(),"fileName":string(),
 "sha256":string(),"templateVersionId":string(),
 "state":string(enum=["pending","approved","rejected","cancelled","conflicted"]),
 "revision":integer(minimum=1),"candidateId":string(),"requestedBy":string()},
 required=["id","subjectId","fileId","sha256","templateVersionId","state","revision","requestedBy"])
CDW_FORMAL_CREATED = obj({"id":string()},required=["id"])
CDW_FORMAL_READY = obj({"deliveryId":string(),"taskId":string(),"fileId":string(),
 "fileName":string(),"sha256":string()},required=["deliveryId","taskId","fileId","fileName","sha256"])
CDW_DOCUMENT_CLASS = obj({
 "fileId":string(),"approvalClass":string(enum=["pending","general","qms"]),
 "requiresQms":boolean(),"reason":string(),"classifiedBy":string(),"roleBindingId":string(),
},required=["fileId","approvalClass","requiresQms"])
add("GET","/api/workbench/formal-documents/{fileId}/classification",operation(
 "Read server-owned formal approval class for the selected file","CDW","cdwFormalDocumentClass",
 security=SESSION,params=[id_param("fileId","File ID.")],
 responses=dict([json_ok(CDW_DOCUMENT_CLASS,"Server-derived class, not a client-supplied toggle."),
 resp("403",ERR["403"])])))
add("POST","/api/workbench/formal-documents/{fileId}/classification",operation(
 "Record immutable document-control classification before formal approval","CDW","cdwFormalDocumentClassify",
 security=SESSION,params=[id_param("fileId","File ID."),CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({"approvalClass":string(enum=["general","qms"]),
  "reason":string()},required=["approvalClass","reason"])}},
 responses=dict([json_ok(CDW_DOCUMENT_CLASS,"Document-control role required, auditable, cannot downgrade QMS."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
CDW_QMS_APPOINTMENT=obj({
 "id":string(),"fileId":string(),"userId":string(),"nodeKey":string(),
 "policyReleaseId":string(),"evidenceReleaseId":string(),"expiresAt":timestamp(),
 "status":string(enum=["pending","verified","revoked"]),"proposedBy":string(),
 "verifiedBy":string(),"reason":string(),
},required=["id","fileId","userId","nodeKey","policyReleaseId",
 "evidenceReleaseId","expiresAt","status","proposedBy","reason"])
add("GET","/api/workbench/qms-appointments/files/{fileId}",operation(
 "List QMS appointment evidence scoped to a visible file","CDW","cdwQMSListAppointments",
 security=SESSION,params=[id_param("fileId","File ID.")],
 responses=dict([json_ok(obj({"items":arr(CDW_QMS_APPOINTMENT)},required=["items"]),
 "Appointment status, source and reviewer are read from the server."),resp("403",ERR["403"])])))
add("GET","/api/workbench/qms-appointments/pending",operation(
 "Independent document-control QMS appointment review queue","CDW","cdwQMSPendingReview",
 security=SESSION,
 responses=dict([json_ok(obj({"items":arr(obj({
 "id":string(),"fileId":string(),"fileName":string(),"evidenceFileId":string(),
 "evidenceFileName":string(),"evidenceReleaseId":string(),"userId":string(),
 "nodeKey":string(),"policyReleaseId":string(),"expiresAt":timestamp(),"status":string(),
 "proposedBy":string(),"reason":string(),
 },required=["id","fileId","fileName","evidenceFileId","evidenceFileName",
 "evidenceReleaseId","userId","nodeKey","policyReleaseId","expiresAt","status","proposedBy","reason"]))},
 required=["items"]),
 "Current reviewer roles and file visibility intersect; excludes proposer and nominee."),
 resp("403",ERR["403"])])))
add("POST","/api/workbench/qms-appointments",operation(
 "Record an unverified QMS signer appointment; does not itself grant signing rights",
 "CDW","cdwQMSProposeAppointment",security=SESSION,params=[CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({
 "fileId":string(),"userId":string(),"nodeKey":string(),
 "policyReleaseId":string(),"evidenceReleaseId":string(),"expiresAt":timestamp(),
 "reason":string()},required=["fileId","userId","nodeKey","policyReleaseId",
 "evidenceReleaseId","expiresAt","reason"])}},
 responses=dict([json_ok(CDW_QMS_APPOINTMENT,"Pending independent document-control verification."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("POST","/api/workbench/qms-appointments/{id}/verify",operation(
 "Independently confirm documentary signer appointment; proposer and nominee excluded",
 "CDW","cdwQMSVerifyAppointment",security=SESSION,
 params=[id_param("id","Appointment ID."),CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({"statement":string()},required=["statement"])}},
 responses=dict([json_ok(CDW_QMS_APPOINTMENT,"Verified documentary evidence, not automated legal qualification."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("POST","/api/workbench/qms-appointments/{id}/revoke",operation(
 "Irreversibly revoke verified QMS appointment with independently authorized document control",
 "CDW","cdwQMSRevokeAppointment",security=SESSION,
 params=[id_param("id","Appointment ID."),CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({"reason":string()},required=["reason"])}},
 responses=dict([json_ok(CDW_QMS_APPOINTMENT,"Revoked qualification; recipient alerts written atomically."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("GET","/api/workbench/qms-appointments/{id}/evidence",operation(
 "Stream exact effective, immutable, sha-bound appointment evidence DOCX (not file latest)",
 "CDW","cdwQMSAppointmentEvidence",security=SESSION,
 params=[id_param("id","Appointment ID.")],
 responses={"200":{"description":"Exact controlled distribution DOCX, with X-CDW-Artifact-SHA256"},
 "403":{"description":"Document-control or source ACL missing"},
 "409":{"description":"Controlled evidence no longer effective"}}))
CDW_QMS_ALERT=obj({"id":string(),"appointmentId":string(),"fileId":string(),
 "nodeKey":string(),"createdAt":timestamp(),"readAt":timestamp()},
 required=["id","appointmentId","fileId","nodeKey","createdAt"])
add("GET","/api/workbench/qms-appointment-alerts",operation(
 "Current user's durable appointment-revocation notices","CDW","cdwQMSAlerts",
 security=SESSION,responses=dict([json_ok(obj({"items":arr(CDW_QMS_ALERT)},required=["items"]),
 "Recipient-only, file-ACL filtered durable alerts"),resp("403",ERR["403"])])))
add("POST","/api/workbench/qms-appointment-alerts/{id}/read",operation(
 "Record recipient acknowledgement of an appointment-revocation notice",
 "CDW","cdwQMSReadAlert",security=SESSION,
 params=[id_param("id","Alert ID."),CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({})}},
 responses=dict([json_ok(obj({"id":string(),"read":boolean()},required=["id","read"]),
 "Only the intended recipient may acknowledge"),resp("404",ERR["404"])])))
CDW_QMS_SPECIAL=obj({
 "id":string(),"fileId":string(),"fileName":string(),"kind":string(enum=["dhf","dmr"]),
 "templateVersionId":string(),"policyReleaseId":string(),"policyFileId":string(),
 "policyName":string(),"status":string(enum=["pending","verified","revoked","returned","rejected"]),
 "reason":string(),"proposedBy":string(),"verifiedBy":string(),"verificationStatement":string(),
 "reviewedBy":string(),"reviewReason":string(),
 "nodeClaims":arr(obj({"nodeKey":string(),"clauseRef":string(),"basisSummary":string()},
 required=["nodeKey","clauseRef","basisSummary"]))},
 required=["id","fileId","fileName","kind","templateVersionId","policyReleaseId",
 "policyFileId","policyName","status","reason","proposedBy","nodeClaims"])
add("GET","/api/workbench/qms-special-authorities",operation(
 "Live document-control scope and file-ACL intersected dedicated DHF/DMR authority requests",
 "CDW","cdwQMSSpecialList",security=SESSION,
 responses=dict([json_ok(obj({"items":arr(CDW_QMS_SPECIAL)},required=["items"]),
 "Verified is valid only while the exact dedicated source remains effective."),
 resp("403",ERR["403"])])))
add("POST","/api/workbench/qms-special-authorities",operation(
 "Propose an exact DHF or DMR file+template+dedicated controlled source binding",
 "CDW","cdwQMSSpecialPropose",security=SESSION,params=[CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({
 "fileId":string(),"kind":string(enum=["dhf","dmr"]),
 "templateVersionId":string(),"policyReleaseId":string(),"reason":string(),
 "nodeClaims":arr(obj({"nodeKey":string(),"clauseRef":string(),"basisSummary":string()},
 required=["nodeKey","clauseRef","basisSummary"]))},
 required=["fileId","kind","templateVersionId","policyReleaseId","reason","nodeClaims"])}},
 responses=dict([json_ok(CDW_QMS_SPECIAL,"Pending independent document-control review."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
for action,label in [("verify","Independently validate the dedicated issued policy"),
 ("return","Return incomplete evidence for a fresh corrected proposal"),
 ("reject","Reject unsupported dedicated authority claim with reasons"),
 ("revoke","Withdraw dedicated DHF/DMR policy approval scope")]:
 add("POST",f"/api/workbench/qms-special-authorities/{{id}}/{action}",operation(
  label,"CDW",f"cdwQMSSpecial{action.title()}",security=SESSION,
  params=[id_param("id","Dedicated authority record ID."),CDW_IDEMPOTENCY],
  request={"application/json":{"schema":obj({"statement":string()},required=["statement"])}},
  responses=dict([json_ok(CDW_QMS_SPECIAL,"Independent, auditable state transition."),
  resp("403",ERR["403"]),resp("409",ERR["409"])])))
CDW_QMS_SPECIAL_ALERT=obj({
 "id":string(),"authorityId":string(),"fileId":string(),
 "kind":string(enum=["dhf","dmr"]),"eventKind":string(enum=["returned","rejected","revoked"]),
 "createdAt":timestamp(),"readAt":timestamp()},
 required=["id","authorityId","fileId","kind","eventKind","createdAt"])
add("GET","/api/workbench/qms-special-alerts",operation(
 "Recipient-specific returned, rejected, or revoked DHF/DMR authority notifications",
 "CDW","cdwQMSSpecialAlerts",security=SESSION,
 responses=dict([json_ok(obj({"items":arr(CDW_QMS_SPECIAL_ALERT)},required=["items"]),
 "Durable recipient notices; not implicitly read or delivered externally."),
 resp("403",ERR["403"])])))
add("POST","/api/workbench/qms-special-alerts/{id}/read",operation(
 "Explicitly acknowledge own dedicated policy status notice","CDW",
 "cdwQMSSpecialReadAlert",security=SESSION,
 params=[id_param("id","Dedicated authority notice ID."),CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({})}},
 responses=dict([json_ok(obj({"id":string(),"read":boolean()},required=["id","read"]),
 "Recipient-specific acknowledged timestamp."),resp("404",ERR["404"])])))
add("GET","/api/workbench/qms-special-authorities/{id}/evidence",operation(
 "Download exact current issued and dispatched source policy artifact, immutable release ID and SHA",
 "CDW","cdwQMSSpecialEvidence",security=SESSION,
 params=[id_param("id","Dedicated authority request ID.")],
 responses={"200":{"description":"Exact controlled DOCX or PDF, never mutable latest, SHA+release response headers."},
  "403":{"description":"Missing live document-control role or file ACL."},
  "409":{"description":"Exact policy release not current or not dispatched as controlled artifact."}}))
CDW_QMS_POLICY_IMPACT=obj({
 "id":string(),"authorityId":string(),"subjectFileId":string(),"subjectName":string(),
 "policyFileId":string(),"oldReleaseId":string(),"newReleaseId":string(),
 "sourceKind":string(enum=["pointer","release_status"]),"state":string(enum=["open","assessed"]),
 "detectedAt":timestamp(),"assessment":string(),
 "disposition":string(enum=["reapproval_required","no_effect_on_existing_records"])},
 required=["id","authorityId","subjectFileId","subjectName","policyFileId","oldReleaseId",
 "sourceKind","state","detectedAt"])
add("GET","/api/workbench/qms-special-policy-impacts",operation(
 "Live document-control scoped automatic impact assessment tasks after dedicated policy changes",
 "CDW","cdwQMSSpecialImpacts",security=SESSION,
 responses=dict([json_ok(obj({"items":arr(CDW_QMS_POLICY_IMPACT)},required=["items"]),
 "Open and assessed tasks scoped to controller and source/subject ACL."),
 resp("403",ERR["403"])])))
add("POST","/api/workbench/qms-special-policy-impacts/{id}/assess",operation(
 "Independently record policy change impact without inventing new signatory authorization",
 "CDW","cdwQMSSpecialAssessImpact",security=SESSION,
 params=[id_param("id","Policy impact task ID."),CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({
 "disposition":string(enum=["reapproval_required","no_effect_on_existing_records"]),
 "assessment":string()},required=["disposition","assessment"])}},
 responses=dict([json_ok(CDW_QMS_POLICY_IMPACT,"Immutable, separate impact conclusion."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
CDW_QMS_INTERRUPTION=obj({
 "id":string(),"approvalInstanceId":string(),"authorityId":string(),
 "subjectFileId":string(),"subjectName":string(),"policyFileId":string(),
 "subjectSha256":string(),"templateVersionId":string(),
 "oldPolicyReleaseId":string(),"replacementPolicyReleaseId":string(),
 "cause":string(enum=["pointer","release_status","authority_revoked"]),
 "completedDecisions":integer(minimum=0),"interruptedNodes":arr(obj({
 "nodeKey":string(),"approverId":string(),"sequence":integer(),"state":string()})),
 "interruptedAt":timestamp()},
 required=["id","approvalInstanceId","authorityId","subjectFileId","subjectName",
 "policyFileId","subjectSha256","templateVersionId","oldPolicyReleaseId",
 "cause","completedDecisions","interruptedNodes","interruptedAt"])
add("GET","/api/workbench/qms-interrupted-approvals",operation(
 "Irreversibly conflicted in-flight DHF/DMR approvals with preserved decision history",
 "CDW","cdwQMSFormalInterruptions",security=SESSION,
 responses=dict([json_ok(obj({"items":arr(CDW_QMS_INTERRUPTION)},required=["items"]),
 "Requester, participant or current controller must also pass both source and subject file ACLs."),
 resp("403",ERR["403"])])))
CDW_QMS_LINEAGE_NODE=obj({
 "approvalId":string(),"previousApprovalId":string(),"fileId":string(),
 "fileName":string(),"sha256":string(),"templateVersionId":string(),
 "policyReleaseId":string(),"state":string(),"requestedBy":string(),
 "requestedAt":timestamp(),"completedAt":timestamp(),
 "stepCount":integer(minimum=0),"approvedCount":integer(minimum=0),
 "rejectedCount":integer(minimum=0),"pendingCount":integer(minimum=0),
 "noticeTotal":integer(minimum=0),"noticeRead":integer(minimum=0),
 "interruptionReason":string(),"candidateId":string()},
 required=["approvalId","fileId","fileName","sha256","templateVersionId",
 "state","requestedBy","requestedAt","stepCount","approvedCount",
 "rejectedCount","pendingCount","noticeTotal","noticeRead"])
add("GET","/api/workbench/qms-formal-lineage/{id}",operation(
 "Read immutable formal approval ancestor/successor chain including live signing and individual notification ACK counts",
 "CDW","cdwQMSFormalLineage",security=SESSION,
 params=[id_param("id","Any approval instance in the chain.")],
 responses=dict([json_ok(obj({"focusApprovalId":string(),
 "nodes":arr(CDW_QMS_LINEAGE_NODE),"truncated":boolean()},
 required=["focusApprovalId","nodes","truncated"]),
 "Requester/current authorized participant/controller, actual source file ACL; read only."),
 resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("GET","/api/workbench/qms-formal-lineage/{id}/audit",operation(
 "Export bounded immutable approval lineage, decision authority snapshots and individual notice evidence",
 "CDW","cdwQMSFormalAudit",security=SESSION,
 params=[id_param("id","Formal approval ID.")],
 responses={"200":{"description":"JSON attachment with X-Content-SHA256, current document-control and file ACL required."},
 "403":{"description":"Document-control role or file authorization missing."},
 "409":{"description":"Full audit export blocked for truncated lineage."}}))
add("GET","/api/workbench/qms-formal-lineage/{id}/audit-segmented",operation(
 "Export a consistent 512-node bounded audit with sixteen-node segments, base64 payloads and chained SHA-256 proofs",
 "CDW","cdwQMSFormalAuditSegmented",security=SESSION,
 params=[id_param("id","Any approval node in the same immutable chain.")],
 responses={"200":{"description":"Complete JSON attachment with hashed, indexed segments and X-Content-SHA256; current controller and full file ACL required."},
 "403":{"description":"Document-control or file preview authorization absent."},
 "409":{"description":"Chain exceeds 512 nodes or continuity fails: no incomplete export returned."}}))
CDW_QMS_PORTFOLIO_ITEM=obj({
 "fileId":string(),"fileName":string(),"approvals":integer(minimum=0),
 "interrupted":integer(minimum=0),"restarts":integer(minimum=0),
 "pending":integer(minimum=0),"approved":integer(minimum=0),
 "unconfirmedNotices":integer(minimum=0),"lastActivityAt":timestamp()},
 required=["fileId","fileName","approvals","interrupted","restarts","pending",
 "approved","unconfirmedNotices","lastActivityAt"])
CDW_QMS_ESCALATION_POLICY=obj({
 "id":string(),"targetFileId":string(),"policyReleaseId":string(),
 "clauseRef":string(),"delayMinutes":integer(minimum=60),"ownerId":string(),
 "reason":string(),"proposedBy":string(),"status":string(enum=["pending","verified","revoked"]),
 "verifiedBy":string(),"proposedAt":timestamp(),"verifiedAt":timestamp()},
 required=["id","targetFileId","policyReleaseId","clauseRef","delayMinutes",
 "ownerId","reason","proposedBy","status","proposedAt"])
CDW_QMS_ESCALATION_CASE=obj({
 "id":string(),"noticeId":string(),"policyId":string(),"targetFileId":string(),
 "ownerId":string(),"escalatedBy":string(),"reason":string(),"escalatedAt":timestamp(),
 "resolution":string(),"resolvedBy":string(),"resolvedAt":timestamp()},
 required=["id","noticeId","policyId","targetFileId","ownerId","escalatedBy","reason","escalatedAt"])
CDW_QMS_ESCALATION_RESOLUTION=obj({
 "id":string(),"caseId":string(),"resolvedBy":string(),"resolution":string(),"resolvedAt":timestamp()},
 required=["id","caseId","resolvedBy","resolution","resolvedAt"])
add("GET","/api/workbench/qms-escalation-policies",operation(
 "List file ACL scoped, independently verifiable in-app escalation policy records",
 "CDW","cdwQMSEscalationPolicies",security=SESSION,
 responses=dict([json_ok(obj({"items":arr(CDW_QMS_ESCALATION_POLICY)},required=["items"]),
 "Current role+file access enforced; no default SLA."),resp("403",ERR["403"])])))
add("POST","/api/workbench/qms-escalation-policies",operation(
 "Propose an explicit controlled in-app escalation policy with effective released source",
 "CDW","cdwQMSEscalationPropose",security=SESSION,params=[CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({
 "targetFileId":string(),"policyReleaseId":string(),"clauseRef":string(),
 "delayMinutes":integer(minimum=60),"ownerId":string(),"reason":string()},
 required=["targetFileId","policyReleaseId","clauseRef","delayMinutes","ownerId","reason"])}},
 responses=dict([json_ok(CDW_QMS_ESCALATION_POLICY,"Pending only until independent controller verification."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("POST","/api/workbench/qms-escalation-policies/{id}/verify",operation(
 "Independently verify exact current effective policy, explicit SLA and appointed owner",
 "CDW","cdwQMSEscalationVerify",security=SESSION,
 params=[id_param("id","Pending escalation policy ID."),CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({"reason":string()},required=["reason"])}},
 responses=dict([json_ok(CDW_QMS_ESCALATION_POLICY,"Immutable verified parameters; proposer cannot self-verify."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("POST","/api/workbench/qms-escalation-policies/{id}/revoke",operation(
 "Independently revoke a policy without deleting historical escalation evidence",
 "CDW","cdwQMSEscalationRevoke",security=SESSION,
 params=[id_param("id","Verified policy ID."),CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({"reason":string()},required=["reason"])}},
 responses=dict([json_ok(CDW_QMS_ESCALATION_POLICY,"Terminal revoked state; current owner/source authorization revalidated."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("GET","/api/workbench/qms-escalation-cases",operation(
 "Scoped and assigned in-app escalation cases, with independent resolution evidence",
 "CDW","cdwQMSEscalationCases",security=SESSION,
 responses=dict([json_ok(obj({"items":arr(CDW_QMS_ESCALATION_CASE)},required=["items"]),
 "Current file ACL and document-control/assigned owner scope required."),resp("403",ERR["403"])])))
add("POST","/api/workbench/qms-formal-interruption-notices/{id}/escalate",operation(
 "Manually escalate one previously followed-up unread notice only after verified-policy delay",
 "CDW","cdwQMSEscalationOpen",security=SESSION,
 params=[id_param("id","Individual unread notice ID."),CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({"policyId":string(),"reason":string()},required=["policyId","reason"])}},
 responses=dict([json_ok(CDW_QMS_ESCALATION_CASE,"In-app case only; no external dispatch or automatic regulator claim."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("POST","/api/workbench/qms-escalation-cases/{id}/resolve",operation(
 "Independent document-control resolution of an escalation, retaining separate read evidence",
 "CDW","cdwQMSEscalationResolve",security=SESSION,
 params=[id_param("id","Open in-app escalation case ID."),CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({"reason":string()},required=["reason"])}},
 responses=dict([json_ok(CDW_QMS_ESCALATION_RESOLUTION,"Immutable documentary closeout distinct from notice receipt."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("GET","/api/workbench/qms-formal-portfolio",operation(
 "Scoped latest 100 controller-authorized files with cross-approval restart and unconfirmed-notice metrics",
 "CDW","cdwQMSFormalPortfolio",security=SESSION,
 responses=dict([json_ok(obj({"items":arr(CDW_QMS_PORTFOLIO_ITEM),
 "limit":integer(minimum=1),"hasMore":boolean()},
 required=["items","limit","hasMore"]),
 "Scoped recent controller portfolio only; does not claim organization-wide completion."),
 resp("403",ERR["403"])])))
CDW_QMS_LEGACY_ANOMALY=obj({
 "approvalInstanceId":string(),"fileId":string(),"fileName":string(),
 "templateVersionId":string(),"requestedBy":string(),"completedDecisions":integer(minimum=0),
 "sha256":string()},required=["approvalInstanceId","fileId","fileName",
 "templateVersionId","requestedBy","completedDecisions","sha256"])
CDW_QMS_FORMAL_NOTICE=obj({
 "id":string(),"approvalInstanceId":string(),"fileId":string(),"recipientId":string(),
 "eventKind":string(enum=["policy_interrupted","legacy_quarantined"]),
 "createdAt":timestamp(),"readAt":timestamp(),"followupAt":timestamp(),
 "followupReason":string(),"followupBy":string()},
 required=["id","approvalInstanceId","fileId","eventKind","createdAt"])
CDW_QMS_FOLLOWUP=obj({
 "id":string(),"noticeId":string(),"approvalInstanceId":string(),
 "recipientId":string(),"requestedBy":string(),"reason":string(),"requestedAt":timestamp()},
 required=["id","noticeId","approvalInstanceId","recipientId","requestedBy","reason","requestedAt"])
add("GET","/api/workbench/qms-formal-notice-ledger",operation(
 "Current document-control scoped per-recipient notice and human follow-up ledger",
 "CDW","cdwQMSFormalNoticeLedger",security=SESSION,
 responses=dict([json_ok(obj({"items":arr(CDW_QMS_FORMAL_NOTICE)},required=["items"]),
 "File ACL-filtered read-only ledger; no assumed regulatory overdue threshold."),
 resp("403",ERR["403"])])))
add("POST","/api/workbench/qms-formal-interruption-notices/{id}/followup",operation(
 "Record one human-initiated reminder for an unread named recipient notice",
 "CDW","cdwQMSFormalFollowup",security=SESSION,
 params=[id_param("id","Unread recipient notice ID."),CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({"reason":string()},required=["reason"])}},
 responses=dict([json_ok(CDW_QMS_FOLLOWUP,"Immutable controller reminder, independent of legal SLA."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("GET","/api/workbench/qms-legacy-approval-anomalies",operation(
 "Live ACL-filtered historical pending DHF/DMR approvals lacking current signatory authority",
 "CDW","cdwQMSLegacyAnomalies",security=SESSION,
 responses=dict([json_ok(obj({"items":arr(CDW_QMS_LEGACY_ANOMALY)},required=["items"]),
 "Read-only anomaly discovery does not rewrite existing records."),resp("403",ERR["403"])])))
add("GET","/api/workbench/qms-legacy-approval-holds",operation(
 "Immutable quarantined historical approvals for traceability and new approval lineage",
 "CDW","cdwQMSLegacyHoldHistory",security=SESSION,
 responses=dict([json_ok(obj({"items":arr(obj({
 "id":string(),"approvalInstanceId":string(),"fileId":string(),
 "state":string(enum=["conflicted"])},
 required=["id","approvalInstanceId","fileId","state"]))},required=["items"]),
 "Only original requester, signers or live controller with current file preview ACL."),
 resp("403",ERR["403"])])))
add("POST","/api/workbench/qms-legacy-approval-anomalies/{id}/hold",operation(
 "Independently quarantine one historical anomalous pending approval with immutable explanation",
 "CDW","cdwQMSLegacyHold",security=SESSION,
 params=[id_param("id","Historical approval instance."),CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({"reason":string()},required=["reason"])}},
 responses=dict([json_ok(obj({"id":string(),"approvalInstanceId":string(),"fileId":string(),"state":string()},
 required=["id","approvalInstanceId","fileId","state"]),"New terminal conflict, never modifies signed history."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("GET","/api/workbench/qms-formal-interruption-notices",operation(
 "Recipient-specific formal interruption and legacy quarantine inbox",
 "CDW","cdwQMSFormalNotices",security=SESSION,
 responses=dict([json_ok(obj({"items":arr(CDW_QMS_FORMAL_NOTICE)},required=["items"]),
 "Preserves individual read timestamps."),resp("403",ERR["403"])])))
add("POST","/api/workbench/qms-formal-interruption-notices/{id}/read",operation(
 "Confirm only your own formal approval interruption notice",
 "CDW","cdwQMSFormalNoticeRead",security=SESSION,
 params=[id_param("id","Notice ID."),CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({})}},
 responses=dict([json_ok(obj({"id":string(),"read":boolean()},required=["id","read"]),
 "Recipient-only acknowledgement."),resp("404",ERR["404"])])))
add("POST","/api/workbench/formal-templates",operation(
 "Publish immutable versioned formal approval template","CDW","cdwFormalTemplatePublish",
 security=SESSION,params=[CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({"templateKey":string(),"steps":arr(CDW_FORMAL_STEP),
 "authorityBasisReleaseId":string("Mandatory for a QMS template; must reference current effective CDW policy release.")},
 required=["templateKey","steps"])}},
 responses=dict([json_ok(CDW_FORMAL_CREATED,"Published version ID; administrator only."),resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("POST","/api/workbench/formal-roles",operation(
 "Grant file-scoped formal approver role; does not issue or activate a document","CDW","cdwFormalRoleGrant",
 security=SESSION,params=[CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({"userId":string(),"fileId":string(),
 "authorityBasisReleaseId":string("QMS formal approver evidence must match the template policy release.")},
 required=["userId","fileId"])}},
 responses=dict([json_ok(CDW_FORMAL_CREATED,"Role binding ID; administrator only."),resp("403",ERR["403"])])))
add("POST","/api/workbench/formal-approvals",operation(
 "Freeze accepted root delivery as separate formal approval subject","CDW","cdwFormalCreate",
 security=SESSION,params=[CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({"deliveryId":string(),"templateVersionId":string(),
 "replacesApprovalId":string("Optional immutable prior quarantined formal approval ID, subject to same-file and current-policy checks.")},
 required=["deliveryId","templateVersionId"])}},
 responses=dict([json_ok(CDW_FORMAL_APPROVAL,"New pending approval; NOT an effective version."),resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("GET","/api/workbench/formal-approvals/ready",operation(
 "List verified, ACL-visible accepted root-task frozen deliveries eligible for formal submission","CDW","cdwFormalReady",
 security=SESSION,
 responses=dict([json_ok(obj({"items":arr(CDW_FORMAL_READY)},required=["items"]),"Admin-only ready deliveries."),
 resp("403",ERR["403"])])))
add("GET","/api/workbench/formal-approvals/inbox",operation(
 "Formal review instances awaiting the principal's current live role","CDW","cdwFormalInbox",
 security=SESSION,params=[query("limit","Number of approvals, 1..100",integer(minimum=1))],
 responses=dict([json_ok(obj({"items":arr(CDW_FORMAL_APPROVAL)},required=["items"]),"Ready and authorized formal decisions."),
 resp("403",ERR["403"])])))
add("GET","/api/workbench/formal-approvals/{id}",operation(
 "Approval detail with immutable frozen SHA, node timeline and decision evidence","CDW","cdwFormalDetail",
 security=SESSION,params=[id_param("id","Approval instance ID.")],
 responses=dict([json_ok(obj({"approval":CDW_FORMAL_APPROVAL,
 "steps":arr(obj({"id":string(),"nodeKey":string(),"sequence":integer(),"approverId":string(),
 "state":string(),"revision":integer()})),
 "decisions":arr(obj({"stepId":string(),"actorId":string(),"decision":string(),
 "reason":string(),"decidedAt":timestamp()}))},required=["approval","steps","decisions"]),"Authorized timeline."),
 resp("403",ERR["403"])])))
add("GET","/api/workbench/formal-approvals/{id}/content",operation(
 "Download exact immutable approval subject DOCX, not mutable latest file","CDW","cdwFormalContent",
 security=SESSION,params=[id_param("id","Approval instance ID.")],
 responses={"200":{"description":"Immutable delivery DOCX with authorization recheck"},
 "403":{"description":"Principal lacks live file and formal subject access"}}))
add("POST","/api/workbench/formal-approvals/{id}/decide",operation(
 "Approve/reject one ready step with CAS, immutable decision evidence and outbox","CDW","cdwFormalDecide",
 security=SESSION,params=[id_param("id","Approval instance ID."),CDW_IDEMPOTENCY,CDW_IF_MATCH],
 request={"application/json":{"schema":obj({"decision":string(enum=["approve","reject"]),
 "reason":string(max_length=3000)},required=["decision"])}},
 responses=dict([json_ok(CDW_FORMAL_APPROVAL,"Candidate produced only after all mandatory steps approve; never activates file."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))

# --- G8 controlled release preparation (approval != preparation != issue != activation) ---
CDW_CONTROL_CANDIDATE=obj({"id":string(),"fileId":string(),"fileName":string(),
 "sha256":string(),"approvedAt":timestamp()},required=["id","fileId","fileName","sha256","approvedAt"])
CDW_CONTROL_RELEASE=obj({"id":string(),"fileId":string(),"fileName":string(),"candidateId":string(),
 "revisionLabel":string(),"sha256":string(),
 "state":string(enum=["preparing","ready","issued_pending","effective","superseded","withdrawn","cancelled"]),
 "revision":integer(minimum=1),"plannedEffectiveAt":timestamp()},
 required=["id","fileId","fileName","candidateId","revisionLabel","sha256","state","revision"])
CDW_ACTIVATION_DECISION=obj({
 "releaseId":string(),"fileId":string(),"outcome":string(enum=["activated","blocked"]),
 "revision":integer(minimum=1),"pointerRevision":integer(minimum=0),
 "priorReleaseId":string(),"effectiveAt":timestamp(),"blockers":arr(string())},
 required=["releaseId","fileId","outcome","revision","pointerRevision","blockers"])
CDW_ACTIVATION_ATTEMPT=obj({
 "id":string(),"releaseId":string(),"actorId":string(),
 "outcome":string(enum=["activated","blocked","failed"]),
 "triggerKind":string(enum=["manual","scheduler","recovery"]),
 "attemptedAt":timestamp(),"blockers":arr(string())},
 required=["id","releaseId","actorId","outcome","triggerKind","attemptedAt","blockers"])
CDW_ACTIVATION_SCHEDULE=obj({
 "releaseId":string(),"sponsorId":string(),
 "status":string(enum=["not_configured","enabled","paused","completed","cancelled"]),
 "revision":integer(minimum=0),"releaseRevision":integer(minimum=1),
 "nextAttemptAt":timestamp(),"attempts":integer(minimum=0),
 "lastBlockers":arr(string()),"lastError":string()},
 required=["releaseId","sponsorId","status","revision","releaseRevision","nextAttemptAt","attempts","lastBlockers","lastError"])
CDW_EFFECTIVE_HIT=obj({
 "fileId":string(),"releaseId":string(),"fileName":string(),"sha256":string(),
 "effectiveAt":timestamp(),"snippet":string()},
 required=["fileId","releaseId","fileName","sha256","effectiveAt","snippet"])
add("GET","/api/workbench/controlled/effective-search",operation(
 "Search ONLY current effective immutable DOCX distribution artifacts using SHA-bound independent fulltext projection. Verify folder/file visibility and live release preview grant for every result; exclude withdrawn/superseded/pending/unsafe index. No cache.",
 "CDW","cdwSearchEffective",security=SESSION,params=[
 {"name":"q","in":"query","schema":{"type":"string","maxLength":120},"description":"Optional approved filename or immutable issued-content search"},
 {"name":"cursor","in":"query","schema":{"type":"string","maxLength":512},"description":"Keyset continuation for stable effective-at order"},
 {"name":"limit","in":"query","schema":{"type":"integer","minimum":1,"maximum":50},"description":"Page size, default 30"}],
 responses=dict([json_ok(obj({"items":arr(CDW_EFFECTIVE_HIT),"nextCursor":string()},
  required=["items","nextCursor"]),"Each hit has a verified effective release SHA; ordinary latest file_text is never a fallback."),
 resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"])])))
add("GET","/api/workbench/controlled/releases/{id}/schedule",operation(
 "Read explicit opt-in automatic effectivity configuration and last durable blocker; requires live document-control authorization",
 "CDW","cdwScheduleRead",security=SESSION,params=[id_param("id","Controlled release ID")],
 responses=dict([json_ok(CDW_ACTIVATION_SCHEDULE,"A planned date alone does not authorize automatic activation."),
 resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("POST","/api/workbench/controlled/releases/{id}/schedule",operation(
 "Enable or cancel explicit planned activation by currently authorized document controller with CAS and idempotent audit/outbox; scheduler rechecks identity, receipt, reading, artifact, paper and supersession constraints",
 "CDW","cdwScheduleSet",security=SESSION,
 params=[id_param("id","Issued controlled release ID"),CDW_IDEMPOTENCY,CDW_IF_MATCH],
 request={"application/json":{"schema":obj({"enabled":{"type":"boolean"}},required=["enabled"])}},
 responses=dict([json_ok(CDW_ACTIVATION_SCHEDULE,"Schedule and release CAS revisions advanced atomically; no automatic activation implied."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("GET","/api/workbench/controlled/releases/{id}/activation-history",operation(
 "Read up to 100 immutable actual release activation attempts with original blockers and actors; requires current document-control authorization",
 "CDW","cdwActivationHistory",security=SESSION,
 params=[id_param("id","Controlled release ID")],
 responses=dict([json_ok(obj({"items":arr(CDW_ACTIVATION_ATTEMPT)},required=["items"]),
 "Only scoped document controllers can read the retained activation audit trail."),
 resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("POST","/api/workbench/controlled/releases/{id}/activate",operation(
 "CAS-controlled manual activation: validate scope, immutable artifact, all department receipts, required reading, paper issuance, planned time and predecessor withdrawal; append immutable activation attempt; atomically advance effective pointer and audit/outbox only on success",
 "CDW","cdwActivation",security=SESSION,
 params=[id_param("id","Issued controlled release ID"),CDW_IDEMPOTENCY,CDW_IF_MATCH],
 request={"application/json":{"schema":obj({})}},
 responses=dict([json_ok(CDW_ACTIVATION_DECISION,
 "Blocked outcome is audited and never changes the effective pointer; activated outcome advances it atomically."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("GET","/api/workbench/controlled/candidates",operation(
 "List formally approved immutable candidates available to document control","CDW","cdwControlCandidates",
 security=SESSION,responses=dict([json_ok(obj({"items":arr(CDW_CONTROL_CANDIDATE)},required=["items"]),
 "Only file-visible approved candidates, authorized officer or admin."),resp("403",ERR["403"])])))
add("GET","/api/workbench/controlled/files/{fileId}/releases",operation(
 "List file-controlled release lifecycle and revision; never read file_versions.latest as effective","CDW","cdwControlList",
 security=SESSION,params=[id_param("fileId","File ID.")],
 responses=dict([json_ok(obj({"items":arr(CDW_CONTROL_RELEASE)},required=["items"]),
 "File ACL enforced on read."),resp("403",ERR["403"])])))
add("POST","/api/workbench/controlled/role",operation(
 "Explicit file-scoped document control officer authorization, admin only","CDW","cdwControlGrantRole",
 security=SESSION,params=[CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({"userId":string(),"fileId":string()},required=["userId","fileId"])}},
 responses=dict([json_ok(CDW_FORMAL_CREATED,"Role binding ID."),resp("403",ERR["403"])])))
add("POST","/api/workbench/controlled/releases",operation(
 "Prepare controlled release from approved immutable Blob, never issue or activate implicitly","CDW","cdwControlPrepare",
 security=SESSION,params=[CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({"candidateId":string(),"revisionLabel":string(max_length=60),
 "plannedEffectiveAt":timestamp()},required=["candidateId","revisionLabel"])}},
 responses=dict([json_ok(CDW_CONTROL_RELEASE,"Created in preparing state with source-only artifact."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))

# --- G11 explicit obligation completion, separate from delivery acceptance ---
CDW_OBLIGATION_FULFILLMENT = obj({"obligationId":string(),"taskId":string(),
 "fileId":string(),"kind":string(enum=["manage","integrate","report"]),
 "state":string(enum=["fulfilled"]),"revision":integer(minimum=2),"fulfilledBy":string(),
 "evidenceSha256":string(),"fulfilledAt":timestamp()},
 required=["obligationId","taskId","fileId","kind","state","revision",
 "fulfilledBy","evidenceSha256","fulfilledAt"])
add("POST","/api/workbench/obligations/{id}/fulfill",operation(
 "Record explicit accountable management/integration/reporting with frozen evidence, CAS and no automatic waiver","CDW","cdwCompleteObligation",
 security=SESSION,params=[id_param("id","Pending obligation ID."),CDW_IDEMPOTENCY,CDW_IF_MATCH],
 request={"application/json":{"schema":obj({"statement":{"type":"string","minLength":12,"maxLength":3000}},
 required=["statement"])}},
 responses=dict([json_ok(CDW_OBLIGATION_FULFILLMENT,"Real fulfillment receipt; subordinate acceptance remains a prerequisite only."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))

# --- G8 document-control release distribution artifact verification ---
add("POST","/api/workbench/controlled/releases/{id}/verify",operation(
 "Verify source-identical DOCX distribution artifact, recording explicit no-seal/no-conversion evidence","CDW","cdwControlVerify",
 security=SESSION,params=[id_param("id","Prepared release ID."),CDW_IDEMPOTENCY,CDW_IF_MATCH],
 request={"application/json":{"schema":obj({
 "justification":{"type":"string","minLength":24,"maxLength":3000},
 "noAdditionalSealRequired":boolean(),"noConversionRequired":boolean()},
 required=["justification","noAdditionalSealRequired","noConversionRequired"])}},
 responses=dict([json_ok(CDW_CONTROL_RELEASE,"State advances preparing to ready; DOES NOT issue, activate or notify departments."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))

# --- G9 server-reconstructed canonical department distribution scope ---
CDW_DISTRIBUTION_TARGET=obj({"departmentId":string(),"receiverId":string(),
 "channel":string(enum=["electronic","paper","mixed"]),"paperQuantity":integer(minimum=0)},
 required=["departmentId","receiverId"])
CDW_DISTRIBUTION_PLAN=obj({"id":string(),"releaseId":string(),"fileId":string(),
 "fileName":string(),"state":string(enum=["draft","frozen","approved","dispatched","cancelled"]),
 "revision":integer(minimum=1),"digestSha256":string(),
 "departmentCount":integer(minimum=1),"targets":arr(CDW_DISTRIBUTION_TARGET)},
 required=["id","releaseId","fileId","fileName","state","revision","departmentCount"])
add("POST","/api/workbench/distribution-plans",operation(
 "Create electronic/paper/mixed department distribution draft for verified release; physically numbered copies are separately managed","CDW","cdwDistributionCreate",
 security=SESSION,params=[CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({"releaseId":string(),
 "targets":arr(CDW_DISTRIBUTION_TARGET)},required=["releaseId","targets"])}},
 responses=dict([json_ok(CDW_DISTRIBUTION_PLAN,"Draft plan, not issued or distributed."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("GET","/api/workbench/controlled/releases/{id}/distribution-plan",operation(
 "Look up retained distribution scope for exact controlled release","CDW","cdwDistributionForRelease",
 security=SESSION,params=[id_param("id","Release ID")],
 responses=dict([json_ok(CDW_DISTRIBUTION_PLAN,"Returns draft or immutable frozen plan with designated departments and receivers."),
 resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("GET","/api/workbench/distribution-plans/{id}",operation(
 "Read controlled distribution scope and canonical digest","CDW","cdwDistributionRead",
 security=SESSION,params=[id_param("id","Plan ID")],
 responses=dict([json_ok(CDW_DISTRIBUTION_PLAN,"The current controlled distribution scope."),
 resp("403",ERR["403"])])))
add("POST","/api/workbench/distribution-plans/{id}/freeze",operation(
 "Freeze exact database-derived plan digest and prohibit later target/item rewrites; scope approval remains independent","CDW","cdwDistributionFreeze",
 security=SESSION,params=[id_param("id","Plan ID"),CDW_IDEMPOTENCY,CDW_IF_MATCH],
 request={"application/json":{"schema":obj({})}},
 responses=dict([json_ok(CDW_DISTRIBUTION_PLAN,"Frozen immutable manifest pending scope approval, NOT dispatched."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))

# --- G9 scope reviewer roles ---
add("POST", "/api/workbench/distribution-scope-roles", operation(
 "Appoint file-level scope approver", "CDW", "cdwDistributionScopeGrant",
 security=SESSION, params=[CDW_IDEMPOTENCY],
 request={"application/json": {"schema": obj({"fileId": string(), "userId": string()}, required=["fileId", "userId"])}},
 responses=dict([json_ok(obj({"id": string()}, required=["id"]), "Explicit reviewer appointment."),
                 resp("403", ERR["403"])])))

# --- G9 frozen scope inbox ---
add("GET", "/api/workbench/distribution-scope/inbox", operation(
 "Pending frozen scopes for independently appointed approvers", "CDW", "cdwDistributionScopeInbox",
 security=SESSION,
 responses=dict([json_ok(obj({"items": arr(CDW_DISTRIBUTION_PLAN)}, required=["items"]),
                         "Authorized frozen plans only."), resp("403", ERR["403"])])))

# --- G9 independent frozen scope approval ---
add("POST", "/api/workbench/distribution-plans/{id}/approve-scope", operation(
 "Authorize exact frozen scope digest without issuing a batch", "CDW", "cdwDistributionScopeApprove",
 security=SESSION, params=[id_param("id", "Frozen plan ID"), CDW_IDEMPOTENCY, CDW_IF_MATCH],
 request={"application/json": {"schema": obj({})}},
 responses=dict([json_ok(CDW_DISTRIBUTION_PLAN, "Approved scope, not dispatched."),
                 resp("403", ERR["403"]), resp("409", ERR["409"])])))

# --- G9 explicit release issue; never activates effective pointer ---
add("POST", "/api/workbench/controlled/releases/{id}/issue", operation(
 "Issue approved frozen release after independent scope approval and digest validation", "CDW", "cdwControlIssue",
 security=SESSION, params=[id_param("id", "Controlled release ID"), CDW_IDEMPOTENCY, CDW_IF_MATCH],
 request={"application/json": {"schema": obj({})}},
 responses=dict([json_ok(CDW_CONTROL_RELEASE, "Issued pending; no effective pointer change."),
                 resp("403", ERR["403"]), resp("409", ERR["409"])])))

CDW_BATCH_RESULT = obj({"id": string(), "planId": string(), "releaseId": string(),
 "fileId": string(), "state": string(enum=["dispatched"]), "revision": integer(minimum=2),
 "digestSha256": string(), "departmentCount": integer(minimum=1)},
 required=["id","planId","releaseId","fileId","state","revision","digestSha256","departmentCount"])
add("POST", "/api/workbench/distribution-plans/{id}/dispatch", operation(
 "Atomically distribute exact approved issue to immutable departmental batch and scoped grants", "CDW", "cdwDistributionDispatch",
 security=SESSION, params=[id_param("id", "Approved plan ID"), CDW_IDEMPOTENCY, CDW_IF_MATCH],
 request={"application/json": {"schema": obj({})}},
 responses=dict([json_ok(CDW_BATCH_RESULT, "Batch dispatched; receipt and reading remain unconfirmed."),
                 resp("403", ERR["403"]), resp("409", ERR["409"])])))

CDW_RECEIPT_TARGET = obj({"targetId":string(),"batchId":string(),"fileId":string(),
 "fileName":string(),"revisionLabel":string(),"departmentId":string(),"receiverId":string(),
 "manifestSha256":string(),"artifactSha256":string(),"state":string(enum=["awaiting","received"]),
 "revision":integer(minimum=1)},
 required=["targetId","batchId","fileId","fileName","revisionLabel","departmentId",
 "receiverId","manifestSha256","artifactSha256","state","revision"])
add("GET","/api/workbench/distribution-targets/inbox",operation(
 "Read live department receipt assignments for the authenticated designated receiver","CDW","cdwReceiptInbox",
 security=SESSION,
 responses=dict([json_ok(obj({"items":arr(CDW_RECEIPT_TARGET)},required=["items"]),
 "Real departmental receipt requirements and receipt-head revisions."),resp("403",ERR["403"])])))

CDW_RECEIPT_RESULT = obj({"receiptId":string(),"targetId":string(),"batchId":string(),
 "fileId":string(),"actorId":string(),"state":string(enum=["received"]),
 "revision":integer(minimum=2),"manifestSha256":string(),"evidenceSha256":string(),
 "signedAt":timestamp()},
 required=["receiptId","targetId","batchId","fileId","actorId","state",
 "revision","manifestSha256","evidenceSha256","signedAt"])
add("POST","/api/workbench/distribution-targets/{id}/acknowledge",operation(
 "Sign immutable department receipt using live receiver authorization and frozen release digest","CDW","cdwReceiptAcknowledge",
 security=SESSION,params=[id_param("id","Assigned department target"),CDW_IDEMPOTENCY,CDW_IF_MATCH],
 request={"application/json":{"schema":obj({"statement":{"type":"string","minLength":12,"maxLength":2000}},required=["statement"])}},
 responses=dict([json_ok(CDW_RECEIPT_RESULT,"Signed department receipt; does not complete personal reading or activation."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))

# --- G9 separately frozen personal reading rosters ---
CDW_READING_ROSTER = obj({"id":string(),"targetId":string(),"batchId":string(),
 "fileId":string(),"departmentId":string(),"digestSha256":string(),
 "assignedCount":integer(minimum=1)},
 required=["id","targetId","batchId","fileId","departmentId","digestSha256","assignedCount"])
add("POST","/api/workbench/distribution-targets/{id}/reading-roster",operation(
 "Freeze one department-specific required reading roster after signed receipt","CDW","cdwReadingRosterCreate",
 security=SESSION,params=[id_param("id","Department target ID"),CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({"userIds":arr(string())},required=["userIds"])}},
 responses=dict([json_ok(CDW_READING_ROSTER,"Immutable identity-scoped reading roster, not confirmations."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("GET","/api/workbench/distribution-targets/{id}/reading-roster",operation(
 "Read the signed department's immutable reading roster","CDW","cdwReadingRosterDetail",
 security=SESSION,params=[id_param("id","Department target ID")],
 responses=dict([json_ok(CDW_READING_ROSTER,"Active roster summary."),
 resp("403",ERR["403"]),resp("404",ERR["404"])])))

CDW_READING_ASSIGNMENT = obj({"id":string(),"rosterId":string(),"targetId":string(),
 "batchId":string(),"fileId":string(),"fileName":string(),"revisionLabel":string(),
 "artifactSha256":string(),"userId":string(),"state":string()},
 required=["id","rosterId","targetId","batchId","fileId","fileName",
 "revisionLabel","artifactSha256","userId","state"])
CDW_READING_CONFIRMATION = obj({"assignmentId":string(),"eventId":string(),
 "actorId":string(),"artifactSha256":string(),"state":string(enum=["confirmed"]),
 "confirmedAt":timestamp()},
 required=["assignmentId","eventId","actorId","artifactSha256","state","confirmedAt"])
add("GET","/api/workbench/reading-assignments/inbox",operation(
 "List authentic personal reading obligations for the current authorized reader","CDW","cdwReadingInbox",
 security=SESSION,
 responses=dict([json_ok(obj({"items":arr(CDW_READING_ASSIGNMENT)},required=["items"]),
 "Reader's own assigned, opened and confirmed items."),
 resp("403",ERR["403"])])))
add("POST","/api/workbench/reading-assignments/{id}/confirm",operation(
 "Append exactly one reader-identified evidence event and mark assigned version confirmed","CDW","cdwReadingConfirm",
 security=SESSION,params=[id_param("id","Personal assignment ID"),CDW_IDEMPOTENCY],
 request={"application/json":{"schema":obj({"statement":{"type":"string","minLength":12,"maxLength":2000}},
 required=["statement"])}},
 responses=dict([json_ok(CDW_READING_CONFIRMATION,"Personal reading declaration, not training completion or activation."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("GET","/api/workbench/reading-assignments/{id}/content",operation(
 "Get exactly the immutable issued DOCX artifact for the assigned reader","CDW","cdwReadingContent",
 security=SESSION,params=[id_param("id","Personal assignment ID")],
 responses={"200":{"description":"Exact issued DOCX bytes, not latest working file.",
 "content":{"application/vnd.openxmlformats-officedocument.wordprocessingml.document":{"schema":{"type":"string","format":"binary"}}}},
 "403":{"description":ERR["403"]}}))

add("GET","/api/workbench/distribution-targets/{id}/reading-eligible",operation(
 "List department members with current access to the exact signed distribution","CDW","cdwReadingEligible",
 security=SESSION,params=[id_param("id","Designated receiver's department target")],
 responses=dict([json_ok(obj({"items":arr(obj({"id":string(),"displayName":string()},
 required=["id","displayName"]))},required=["items"]),
 "Receiver-scoped eligible readers, not unrestricted organization directory."),
 resp("403",ERR["403"])])))

CDW_DISTRIBUTION_LEDGER_ROW = obj({
 "targetId":string(),"departmentId":string(),"departmentName":string(),
 "channel":string(enum=["electronic","paper","mixed"]),"paperQuantity":integer(minimum=0),
 "paperIssued":integer(minimum=0),"paperOutstanding":integer(minimum=0),
 "receiverId":string(),"receiverName":string(),"actualSignerId":string(),
 "actualSignerName":string(),"signedAt":timestamp(),"receiptId":string(),
 "receiptStatus":string(enum=["awaiting","received"]),
 "readingAssigned":integer(minimum=0),"readingConfirmed":integer(minimum=0),
 "readingStatus":string(enum=["unassigned","awaiting","partial","confirmed"]),
 "dueAt":timestamp(),"overdue":boolean(),"exceptionReason":string()},
 required=["targetId","departmentId","departmentName","receiverId","receiverName",
 "receiptStatus","readingAssigned","readingConfirmed","readingStatus","overdue",
 "channel","paperQuantity","paperIssued","paperOutstanding"])
CDW_DISTRIBUTION_LEDGER = obj({"planId":string(),"batchId":string(),
 "batchState":string(enum=["dispatched","withdrawn"]),
 "manifestSha256":string(),"rows":arr(CDW_DISTRIBUTION_LEDGER_ROW),
 "receiptCompleted":integer(minimum=0),"readingAssigned":integer(minimum=0),
 "readingConfirmed":integer(minimum=0)},
 required=["planId","batchId","batchState","manifestSha256","rows","receiptCompleted","readingAssigned","readingConfirmed"])
add("GET","/api/workbench/distribution-plans/{id}/ledger",operation(
 "Read truthful department receipts and personal reading progress from primary evidence tables","CDW","cdwDistributionLedger",
 security=SESSION,params=[id_param("id","Dispatched distribution plan ID")],
 responses=dict([json_ok(CDW_DISTRIBUTION_LEDGER,"Document-controller-only controlled distribution audit ledger."),
 resp("403",ERR["403"]),resp("404",ERR["404"])])))

CDW_DISTRIBUTION_WITHDRAWAL=obj({"id":string(),"batchId":string(),
 "planId":string(),"releaseId":string(),"fileId":string(),
 "state":string(enum=["withdrawn"]),"planRevision":integer(minimum=1),
 "manifestSha256":string(),"revokedGrants":integer(minimum=0),
 "cancelledReaders":integer(minimum=0),"invalidatedTargets":integer(minimum=0),
 "actorId":string(),"reason":string()},
 required=["id","batchId","planId","releaseId","fileId","state","planRevision",
 "manifestSha256","revokedGrants","cancelledReaders","invalidatedTargets","actorId","reason"])
add("POST","/api/workbench/distribution-plans/{id}/withdraw",operation(
 "Withdraw issued but not effective batch; revoke scoped grants, cancel pending reads, preserve immutable receipt and reading evidence","CDW","cdwDistributionWithdraw",
 security=SESSION,params=[id_param("id","Dispatched plan ID"),CDW_IDEMPOTENCY,CDW_IF_MATCH],
 request={"application/json":{"schema":obj({
 "reason":{"type":"string","minLength":12,"maxLength":3000}},required=["reason"])}},
 responses=dict([json_ok(CDW_DISTRIBUTION_WITHDRAWAL,
 "Audited withdrawal receipt. An effective release cannot be withdrawn here."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))

CDW_PAPER_COPY=obj({"id":string(),"copyNo":string(),"holderId":string(),
 "state":string(enum=["issued","collected","destroyed","lost","waived"]),
 "revision":integer(minimum=1),"lastEventId":string(),"lastActorId":string(),"lastReason":string()},
 required=["id","copyNo","holderId","state","revision"])
CDW_PAPER_LEDGER=obj({"targetId":string(),"targetRevision":integer(minimum=1),
 "fileId":string(),"batchId":string(),
 "channel":string(enum=["electronic","paper","mixed"]),
 "paperQuantity":integer(minimum=0),"lotId":string(),
 "issued":integer(minimum=0),"collected":integer(minimum=0),"destroyed":integer(minimum=0),
 "lost":integer(minimum=0),"waived":integer(minimum=0),"outstanding":integer(minimum=0),
 "copies":arr(CDW_PAPER_COPY)},
 required=["targetId","targetRevision","fileId","batchId","channel","paperQuantity",
 "issued","collected","destroyed","lost","waived","outstanding","copies"])
CDW_PAPER_TRANSITION=obj({"copyId":string(),"eventId":string(),
 "kind":string(enum=["collected","lost","destroyed"]),
 "state":string(enum=["collected","lost","destroyed"]),"revision":integer(minimum=2),
 "actorId":string(),"reason":string()},
 required=["copyId","eventId","kind","state","revision","actorId","reason"])
add("GET","/api/workbench/distribution-targets/{id}/paper-copies",operation(
 "Read numbered paper-copy issue/return ledger independently of electronic reading acknowledgements",
 "CDW","cdwPaperLedger",security=SESSION,params=[id_param("id","Dispatched target ID")],
 responses=dict([json_ok(CDW_PAPER_LEDGER,"Document-control role required; retained after distribution withdrawal."),
 resp("403",ERR["403"])])))
add("POST","/api/workbench/distribution-targets/{id}/paper-issue",operation(
 "Freeze one paper copy lot with exact frozen approved quantity and individual unique copy numbers",
 "CDW","cdwPaperIssue",security=SESSION,
 params=[id_param("id","Dispatched target ID"),CDW_IDEMPOTENCY,CDW_IF_MATCH],
 request={"application/json":{"schema":obj({"copyNumbers":arr(string())},required=["copyNumbers"])}},
 responses=dict([json_ok(CDW_PAPER_LEDGER,"Frozen issue lot. Electronic delivery does not count as physical issue."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("POST","/api/workbench/paper-copies/{id}/events",operation(
 "Append per-copy physical collection, loss or destruction evidence with CAS; no implicit electronic reading credit",
 "CDW","cdwPaperEvent",security=SESSION,
 params=[id_param("id","Numbered physical copy ID"),CDW_IDEMPOTENCY,CDW_IF_MATCH],
 request={"application/json":{"schema":obj({"kind":string(enum=["collected","lost","destroyed"]),
 "reason":{"type":"string","minLength":12,"maxLength":2000}},required=["kind","reason"])}},
 responses=dict([json_ok(CDW_PAPER_TRANSITION,"Immutable per-copy event and updated state pointer."),
 resp("403",ERR["403"]),resp("409",ERR["409"])])))

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
    auth_note="Origin must match Host, scheme and port; uses HttpOnly cookie, no URL token. Browser clients connect via ws:// on HTTP or wss:// on HTTPS. Up to 512 live connections per server process and 6-second heartbeat. Server-to-client JSON messages only; each event revalidates the session. Existing HTTP APIs remain authoritative."))

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

add("GET", "/api/folders/{id}", operation("Resolve one listable folder by id for deep links beyond the tree hint", "Folders", "folderDetail", security=SESSION,
    params=[id_param("id", "Exact folder id, including results outside the compatibility tree.")],
    responses=dict([json_ok(ref("Folder"), "Selected folder; missing, deleted and hidden ids are indistinguishable."),
                    resp("401", ERR["401"]), resp("403", ERR["403"]),
                    resp("404", "E_NOT_FOUND — missing, deleted or unlistable folder")]),
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

add("GET", "/api/audit/documents", operation("Document activity audit (admin/global auditor)", "Audit", "documentAudit", security=SESSION,
    params=[query("cursor","Descending numeric audit ID"), query("limit","Rows per page, 1-100 (default 30).", integer(minimum=1)),
            query("fileId","Exact target file ID."), query("actorId","Exact actor ID."),
            query("event","Event type prefix, e.g. file.")],
    responses=dict([json_ok(ref("PermissionAuditPage"),"Filtered document lifecycle events."),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"])])))

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

schema("ReplaceTarget",obj({
    "fileId":string(),"name":string(),"folderId":string(),"versionSeq":integer(minimum=1),"size":integer()
},required=["fileId","name","folderId","versionSeq","size"]))
add("GET","/api/files/replace-target",operation("Preflight explicit same-name version replacement","Files","resolveReplaceTarget",security=SESSION,
    params=[query("folderId","Target folder ID",required=True),query("name","Exact existing file name",required=True)],
    responses=dict([json_ok(ref("ReplaceTarget"),"Current, editable and non-locked target; confirmation is required."),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("404",ERR["404"]),resp("409",ERR["409"])])))
add("POST","/api/files/{id}/replace",operation("Append immutable version on explicit, CAS-checked replacement","Files","replaceFileContent",security=SESSION,
    params=[id_param("id","Confirmed existing file ID")],
    request={"multipart/form-data":{"schema":obj({
       "file":{"type":"string","format":"binary"},"folderId":string(),
       "expectedSeq":integer(minimum=1),"idempotencyKey":string(),
    },required=["file","folderId","expectedSeq"])}},
    responses=dict([json_ok(obj({"fileId":string(),"versionSeq":integer(),"sha256":string(),"size":integer(),"name":string(),"folderId":string(),"deduplicated":boolean()}),"File ID preserved; a new immutable version is appended."),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"]),resp("409",ERR["409"]),resp("413",ERR["413"])])))

add("POST","/api/uploads/resumable",operation("Start/resume a private upload (max 1 GiB)","Files","startResumable",security=SESSION,
 request={"application/json":{"schema":ref("ResumableStart")}},
 responses=dict([resp("201","Open or replayed upload session",obj({"ok":boolean(),"data":ref("ResumableStatus")},required=["ok","data"])),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("GET","/api/uploads/resumable/{id}",operation("Read server-confirmed upload offset","Files","resumableStatus",security=SESSION,
 params=[id_param("id","Private upload session ID")],
 responses=dict([json_ok(ref("ResumableStatus"),"Resume only from this offset."),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("PATCH","/api/uploads/resumable/{id}",operation("Append one verified 4 MiB chunk at current offset","Files","resumableChunk",security=SESSION,
 params=[id_param("id","Private upload ID")],
 request={"application/octet-stream":{"schema":{"type":"string","format":"binary"}}},
 responses=dict([json_ok(ref("ResumableStatus"),"Committed byte offset after durable fsync."),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"]),resp("409",ERR["409"]),resp("413",ERR["413"])])))
add("POST","/api/uploads/resumable/{id}/complete",operation("Verify and commit assembled upload as first immutable version","Files","finishResumable",security=SESSION,
 params=[id_param("id","Private upload ID")],
 responses=dict([json_ok(obj({"fileId":string(),"versionSeq":integer(),"sha256":string(),"size":integer(),"name":string(),"folderId":string(),"deduplicated":boolean()}),"Committed upload, replay safe."),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"]),resp("409",ERR["409"])])))
add("DELETE","/api/uploads/resumable/{id}",operation("Cancel private uncommitted upload","Files","cancelResumable",security=SESSION,
 params=[id_param("id","Private upload ID")],
 responses=dict([json_ok(obj({"cancelled":string()}),"Cancelled; pending spool cleaned."),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"]),resp("409",ERR["409"])])))

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

schema("FileHistoryEvent",obj({
  "id":integer(),"actorId":string(),"actorName":string(),"requestId":string(),"eventType":string(),"targetKind":string(),
  "targetId":string(),"outcome":string(),"details":{"type":"object","additionalProperties":True},"createdAt":timestamp()
},required=["id","actorId","requestId","eventType","targetKind","targetId","outcome","details","createdAt"]))
schema("FileHistoryPage",obj({"items":arr(ref("FileHistoryEvent")),"nextCursor":string()},required=["items","nextCursor"]))
add("GET","/api/files/{id}/history",operation("Read ACL-scoped file operation history","Files","fileHistory",security=SESSION,
  params=[id_param("id","Stable file identifier"),query("cursor","Descending audit event ID cursor"),query("limit","Page size 1-100",integer(minimum=1))],
  responses=dict([json_ok(ref("FileHistoryPage"),"Authenticated and file-authorized operation timeline."),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("404",ERR["404"])])))

schema("FileLifecycle",obj({
 "fileId":string(),"state":string(enum=["draft","released","archived"]),
 "publishedSeq":integer(),"publishedAt":timestamp(),"publishedBy":string(),
 "dueAt":timestamp(),"dueStatus":string(enum=["none","soon","overdue","scheduled"]),
 "note":string(),"updatedAt":timestamp(),"canManage":boolean(),
 "retentionUntil":timestamp(),
 "responsibleId":string(),
},required=["fileId","state","publishedSeq","publishedAt","publishedBy","dueStatus","note","updatedAt","canManage"]))
schema("SetFileLifecycle",obj({
 "action":string(enum=["publish","archive","unarchive","set_due","assign"]),
 "expectedVersionSeq":integer(minimum=1),"dueAt":timestamp(),"note":string(max_length=200),
 "retentionDays":integer(minimum=0),"responsibleId":string()
},required=["action","expectedVersionSeq"]))
add("GET","/api/files/{id}/lifecycle",operation("Read lifecycle release, archive and due-date status","Files","fileLifecycle",security=SESSION,
 params=[id_param("id","File ID")],
 responses=dict([json_ok(ref("FileLifecycle"),"Lifecycle with visibility-scoped canManage."),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("PUT","/api/files/{id}/lifecycle",operation("Release current version or archive/unarchive or update due date","Files","setFileLifecycle",security=SESSION,
 params=[id_param("id","File ID")],request={"application/json":{"schema":ref("SetFileLifecycle")}},
 responses=dict([json_ok(ref("FileLifecycle"),"CAS/version-checked, audited state."),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"]),resp("409",ERR["409"])])))

schema("LifecycleLedgerRow",obj({
 "fileId":string(),"fileName":string(),"folderId":string(),"state":string(enum=["released","archived"]),
 "publishedSeq":integer(),"responsibleName":string(),"dueAt":timestamp(),"retentionUntil":timestamp(),
 "dueStatus":string(enum=["none","soon","overdue","scheduled"])
},required=["fileId","fileName","folderId","state","publishedSeq","dueStatus"]))
schema("LifecycleLedgerPage",obj({"items":arr(ref("LifecycleLedgerRow")),"nextCursor":string()},required=["items","nextCursor"]))
schema("LifecycleNotification",obj({
 "id":integer(),"fileId":string(),"fileName":string(),"kind":string(enum=["soon","overdue"]),
 "dueAt":timestamp(),"createdAt":timestamp(),"read":boolean()
},required=["id","fileId","fileName","kind","dueAt","createdAt","read"]))
add("GET","/api/lifecycle/ledger",operation("Page through ACL-visible lifecycle entries","Files","lifecycleLedger",security=SESSION,
 params=[query("cursor","Opaque file ID cursor"),query("state","released or archived"),query("limit","Candidate window 1-50",integer(minimum=1))],
 responses=dict([json_ok(ref("LifecycleLedgerPage"),"ACL-filtered candidate window."),resp("400",ERR["400"]),resp("401",ERR["401"])])))
add("GET","/api/lifecycle/notifications",operation("List current due-date notices scoped to publisher","Files","lifecycleNotifications",security=SESSION,
 responses=dict([json_ok(arr(ref("LifecycleNotification")),"Current ACL-visible reminders."),resp("401",ERR["401"])])))
add("POST","/api/lifecycle/notifications/{id}/read",operation("Mark own lifecycle notice as read","Files","readLifecycleNotification",security=SESSION,
 params=[id_param("id","Notification ID")],
 responses=dict([json_ok(obj({"read":integer()}),"Marked read."),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("404",ERR["404"])])))

schema("LifecyclePolicy",obj({"dueDays":integer(minimum=0),"retentionDays":integer(minimum=0)},required=["dueDays","retentionDays"]))
schema("LifecyclePolicyView",obj({"dueDays":integer(),"retentionDays":integer(),"sourceKind":string(),"sourceId":string(),"canManage":boolean()},required=["dueDays","retentionDays","sourceKind","sourceId","canManage"]))
schema("LifecycleStats",obj({"released":integer(),"archived":integer(),"dueSoon":integer(),"overdue":integer(),"retained":integer()},required=["released","archived","dueSoon","overdue","retained"]))
schema("BulkLifecycleDue",obj({"items":arr(obj({"fileId":string(),"expectedVersionSeq":integer(minimum=1)},required=["fileId","expectedVersionSeq"])),"dueAt":timestamp()},required=["items"]))
schema("BulkLifecycleResult",obj({"fileId":string(),"status":string(enum=["updated","unavailable","version_conflict","conflict","invalid"])},required=["fileId","status"]))
for method,summary,key,request,output in [
 ("GET","View inherited folder or department lifecycle defaults","getLifecyclePolicy",None,ref("LifecyclePolicyView")),
 ("PUT","Update lifecycle defaults (administrator)","putLifecyclePolicy",ref("LifecyclePolicy"),obj({"saved":boolean()})),
 ("DELETE","Clear policy and resume inheritance (administrator)","deleteLifecyclePolicy",None,obj({"cleared":boolean()}))
]:
 add(method,"/api/lifecycle/policy/{kind}/{id}",operation(summary,"Files",key,security=SESSION,
 params=[id_param("kind","folder or department"),id_param("id","Scope ID")],
 request=({"application/json":{"schema":request}} if request is not None else None),
 responses=dict([json_ok(output,"Lifecycle policy scope result"),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("GET","/api/lifecycle/statistics",operation("Aggregate active lifecycle counts (administrator)","Files","lifecycleStatistics",security=SESSION,
 responses=dict([json_ok(ref("LifecycleStats"),"All active document counts"),resp("401",ERR["401"]),resp("403",ERR["403"])])))
add("POST","/api/lifecycle/bulk-due",operation("Independently apply up to twenty lifecycle due dates","Files","bulkLifecycleDue",security=SESSION,
 request={"application/json":{"schema":ref("BulkLifecycleDue")}},
 responses=dict([json_ok(arr(ref("BulkLifecycleResult")),"One status per candidate"),resp("400",ERR["400"]),resp("401",ERR["401"])])))

add("GET", "/api/files/{id}/metadata", operation("Read business metadata of an accessible file", "Files", "fileMetadata", security=SESSION,
    params=[id_param("id","File ID")],
    responses=dict([json_ok(ref("FileBusinessMetadata"),"Current business classification."),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("PUT", "/api/files/{id}/metadata", operation("Update business metadata (modify permission)", "Files", "setFileMetadata", security=SESSION,
    params=[id_param("id","File ID")],
    request={"application/json":{"schema":ref("UpdateFileBusinessMetadata")}},
    responses=dict([json_ok(ref("FileBusinessMetadata"),"Updated and audited classification."),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))

add("GET","/api/files/{id}/versions/compare",operation("Compare two immutable file versions (preview permission)","Files","compareFileVersions",security=SESSION,
 params=[id_param("id","File ID"),query("left","First version",integer(minimum=1),required=True),query("right","Second version",integer(minimum=1),required=True)],
 responses=dict([json_ok(ref("VersionComparison"),"Bounded text diff or binary metadata comparison."),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("GET","/api/files/{id}/review-comments",operation("List version-anchored review comments","Files","listFileReviewComments",security=SESSION,
 params=[id_param("id","File ID"),query("version","Version sequence",integer(minimum=1),required=True),query("cursor","Numeric descending ID cursor"),query("limit","Page size",integer(minimum=1))],
 responses=dict([json_ok(ref("ReviewCommentPage"),"Visible comments."),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("POST","/api/files/{id}/review-comments",operation("Add a review comment on a file version","Files","createFileReviewComment",security=SESSION,
 params=[id_param("id","File ID")],
 request={"application/json":{"schema":ref("CreateReviewComment")}},
 responses=dict([resp("201","Created",obj({"ok":boolean(),"data":ref("ReviewComment")},required=["ok","data"])),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("POST","/api/files/{id}/review-comments/{cid}/resolve",operation("Resolve a comment (author/admin/modify)","Files","resolveFileReviewComment",security=SESSION,
 params=[id_param("id","File ID"),id_param("cid","Review comment ID")],
 responses=dict([json_ok(obj({"resolved":integer()},required=["resolved"]),"Resolved comment."),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"]),resp("409",ERR["409"])])))
for prefix,suffix in [("/api",""),("/api/v1","V1")]:
 add("GET",prefix+"/files/{id}/reviews",operation("List version-scoped review workflows","Files","listReviewFlow"+suffix,security=SESSION,
  params=[id_param("id","File ID"),query("version","Version sequence",integer(minimum=1),required=True),query("filter","Server-side status / assignee filter",string(enum=["all","mine","approval","done"]))],
  responses=dict([json_ok(ref("ReviewCommentPage"),"Review workflow records"),resp("400",ERR["400"]),resp("403",ERR["403"])])))
 add("GET",prefix+"/files/{id}/reviews/{cid}/history",operation("Immutable review transition timeline","Files","reviewHistory"+suffix,security=SESSION,
  params=[id_param("id","File ID"),id_param("cid","Review comment ID")],
  responses=dict([json_ok(arr(ref("ReviewEvent")),"Original review transition receipts and decisions"),resp("403",ERR["403"]),resp("404",ERR["404"])])))
 add("POST",prefix+"/files/{id}/reviews",operation("Create a self or assigned review","Files","createReviewFlow"+suffix,security=SESSION,
  params=[id_param("id","File ID")],request={"application/json":{"schema":ref("CreateReviewComment")}},
  responses=dict([resp("201","Created",obj({"ok":boolean(),"data":ref("ReviewComment")})),resp("400",ERR["400"]),resp("403",ERR["403"])])))
 add("GET",prefix+"/files/{id}/reviews/assignees",operation("List permitted review assignees","Files","reviewAssignees"+suffix,security=SESSION,
  params=[id_param("id","File ID")],responses=dict([json_ok(arr(ref("ReviewAssignee")),"Active users with document preview access"),resp("403",ERR["403"])])))
 add("POST",prefix+"/files/{id}/reviews/{cid}/{action}",operation("Transition a review through assignment, resolution, and acceptance","Files","transitionReview"+suffix,security=SESSION,
  params=[id_param("id","File ID"),id_param("cid","Review comment ID"),
          {"name":"action","in":"path","required":True,"schema":string(enum=["assign","resolve-self","submit-resolution","update-resolution","approve","reject","reopen"])}],
  request={"application/json":{"schema":ref("ReviewTransition")}},
  responses=dict([json_ok(obj({"id":integer(),"updated":boolean()}),"Transition applied atomically"),resp("400",ERR["400"]),resp("403",ERR["403"]),resp("409",ERR["409"])])))
add("GET","/api/review-notifications",operation("Current user's review notifications","Files","reviewNotifications",security=SESSION,
 responses=dict([json_ok(ref("ReviewNotificationPage"),"Recipient-scoped review notifications"),resp("401",ERR["401"])])))
add("POST","/api/review-notifications/{nid}/read",operation("Mark review notification read","Files","readReviewNotification",security=SESSION,
 params=[id_param("nid","Review notification ID")],
 responses=dict([json_ok(obj({"id":integer()}),"Marked read"),resp("401",ERR["401"])])))

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

add("GET", "/api/files/{id}/preview/office-pdf", operation("Isolated Office-to-PDF layout preview (preview ACL only)", "Files", "previewOfficePDF", security=SESSION,
    params=[id_param("id", "File id.")],
    responses={"200": {"description": "Bounded, isolated, read-only OOXML layout rendering; ephemeral PDF (no store).",
                        "content": {"application/pdf": {"schema": {"type": "string", "format": "binary"}}}},
               "401": {"description": ERR["401"]}, "403": {"description": ERR["403"]},
               "404": {"description": ERR["404"]}, "415": {"description": "Unsupported or unsafe Office input."},
               "500": {"description": "Isolated conversion unavailable; client should use textual fallback."}}))

add("POST", "/api/files/{id}/print/prepare", operation("Audit browser print intent (requires preview + print ACL; CDW effective files print the exact controlled distribution artifact, not ordinary latest)", "Files", "prepareBrowserPrint", security=SESSION,
    params=[id_param("id", "File id.")],
    request={"application/json":{"schema":obj({"expectedSha256":string()},required=["expectedSha256"])}},
    responses=dict([json_ok(obj({"fileId":string(),"name":string(),"versionSeq":integer(),"sha256":string(),"controlled":boolean()},
                 required=["fileId","name","versionSeq","sha256","controlled"]), "Browser print authorized. For controlled issues versionSeq is 0 (not ordinary version 0); controlled=true and sha256 pins the active issued artifact. Does not assert physical print completion."),
                 resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"]),resp("409",ERR["409"])])))

add("GET", "/api/files/{id}/print/media", operation("Stream checked PDF or still image for browser print (print + preview ACL)", "Files", "browserPrintMedia", security=SESSION,
    params=[id_param("id", "File id."),{"name":"sha256","in":"query","required":True,"schema":string()}],
    responses={"200":{"description":"Only signature-verified PDF/image, pinned to current version, inline/no-store.",
                      "content":{"application/octet-stream":{"schema":{"type":"string","format":"binary"}}}},
               "206":{"description":"Partial verified media range."},"401":{"description":ERR["401"]},
               "403":{"description":ERR["403"]},"404":{"description":ERR["404"]},
               "409":{"description":ERR["409"]},"415":{"description":"Unsupported printable media."}}))

add("GET", "/api/files/{id}/print/office-pdf", operation("Print-authorized isolated Office PDF conversion (print + preview ACL)", "Files", "browserPrintOfficePDF", security=SESSION,
    params=[id_param("id", "File id."),{"name":"sha256","in":"query","required":True,"schema":string()},
            {"name":"sheet","in":"query","required":False,"schema":string(),"description":"Optional exact visible Excel worksheet name; others hidden only in sandbox conversion copy."}],
    responses={"200":{"description":"Ephemeral PDF conversion in sandbox, never a physical printer job.",
                      "content":{"application/pdf":{"schema":{"type":"string","format":"binary"}}}},
               "401":{"description":ERR["401"]},"403":{"description":ERR["403"]},
               "404":{"description":ERR["404"]},"409":{"description":ERR["409"]},
               "415":{"description":"Unsupported or unsafe Office input."}}))

add("GET", "/api/files/{id}/print/sheets", operation("List visible Excel sheets under print + preview ACL", "Files", "browserPrintSheets", security=SESSION,
    params=[id_param("id","File id."),{"name":"sha256","in":"query","required":True,"schema":string()}],
    responses=dict([json_ok(arr(obj({"name":string()},required=["name"])),"Visible worksheet names from validated workbook; current digest required."),
      resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"]),resp("409",ERR["409"])])))

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

add("DELETE", "/api/groups/{id}", operation("Delete a workgroup (blocked while ACL or shares reference it)", "Organization", "deleteWorkgroup", security=SESSION,
    params=[id_param("id", "Workgroup id.")],
    responses=dict([json_ok(obj({"id": string(), "deleted": {"type": "boolean", "enum": [True]}}, required=["id","deleted"]), "Workgroup deleted."),
                    resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"]), resp("409", ERR["409"])])))
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

schema("SearchPreset",obj({"name":string(max_length=48),"fields":obj({
 "q":string(),"category":string(),"tag":string(),"uploader":string(),"type":string(),
 "sort":string(),"limit":integer(),"scope":string(),"folder":string(),"from":string(),"to":string()
 },required=["q","category","tag","uploader","type","sort","limit","scope","folder","from","to"]),"createdAt":timestamp()},
 required=["name","fields"]))
add("GET","/api/search/presets",operation("List current user's synced saved search criteria","Search","listSearchPresets",security=SESSION,
 responses=dict([json_ok(arr(ref("SearchPreset")),"Personal presets; no document results stored."),resp("401",ERR["401"])])))
add("POST","/api/search/presets",operation("Create or replace a saved search (maximum 12 per user)","Search","saveSearchPreset",security=SESSION,
 request={"application/json":{"schema":ref("SearchPreset")}},
 responses=dict([json_ok(arr(ref("SearchPreset")),"Updated per-user presets."),resp("400",ERR["400"]),resp("401",ERR["401"])])))
add("DELETE","/api/search/presets/{name}",operation("Delete own saved search","Search","deleteSearchPreset",security=SESSION,
 params=[{"name":"name","in":"path","required":True,"schema":string(max_length=48)}],
 responses=dict([json_ok(obj({"deleted":boolean()},required=["deleted"]),"Deleted matching own preset."),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("404",ERR["404"])])))

add("HEAD","/api/files/download-zip",operation("Preflight an authorized bounded ZIP without starting a download","Files","inspectFilesZip",security=SESSION,
 params=[query("ids","1-30 unique file IDs; no ZIP payload")],
 responses=dict([("204",{"description":"All selected files authorized; X-Zip-Files and X-Zip-Original-Bytes response headers."}),
 resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("GET","/api/files/download-zip",operation("Download an authorized bounded ZIP of current file versions","Files","downloadFilesZip",security=SESSION,
 params=[query("ids","1-30 unique comma-separated file IDs, max 512 MiB original bytes")],
 responses=dict([("200",{"description":"Streaming application/zip attachment, after every item is authorized.","content":{"application/zip":{"schema":{"type":"string","format":"binary"}}}}),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))

add("GET", "/api/files/{id}/lock", operation("Lock status", "Workflow", "lockStatus", security=SESSION,
    params=[id_param("id", "File id.")],
    responses=dict([json_ok(ref("LockStatus"), "Lock state."), resp("401", ERR["401"]), resp("403", ERR["403"]), resp("404", ERR["404"])])))


# --- Signature and stamp permissions ---
schema("SealUserPermission",obj({"userId":string(),"displayName":string(),"canSign":boolean(),"canStamp":boolean()},required=["userId","displayName","canSign","canStamp"]))
add("GET","/api/seal-permissions/me",operation("Read my individual signing and stamping authority","Seals","mySealPermission",security=SESSION,
 responses=dict([json_ok(ref("SealUserPermission"),"Permission flags"),resp("401",ERR["401"])])))
add("GET","/api/seal-permissions",operation("Admin list of active users and independent seal authorities","Seals","listSealUserPermissions",security=SESSION,
 responses=dict([json_ok(arr(ref("SealUserPermission")),"Admin-managed permissions"),resp("401",ERR["401"]),resp("403",ERR["403"])])))
add("PUT","/api/seal-permissions/{id}",operation("Admin assign personal-sign and company-stamp privileges separately","Seals","updateSealUserPermission",security=SESSION,
 params=[id_param("id","User ID")],
 request={"application/json":{"schema":obj({"canSign":boolean(),"canStamp":boolean()},required=["canSign","canStamp"])}},
 responses=dict([json_ok(ref("SealUserPermission"),"Saved permission decision"),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))

# --- PDF safe page preview & explicit DOCX signing copy ---
add("GET","/api/files/{id}/preview/office/pages",operation("Count read-only Office-derived image pages without browser PDF viewer","Files","officePreviewPages",security=SESSION,
 params=[id_param("id","File ID"),query("sha256","Exact current source SHA-256",required=True)],
 responses=dict([json_ok(obj({"pageCount":integer(minimum=1)},required=["pageCount"]),"Authorized Office page count"),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"]),resp("409",ERR["409"])])))
add("GET","/api/files/{id}/preview/office/page",operation("Render read-only Office document page as PNG with preview-only permission","Files","officePreviewPage",security=SESSION,
 params=[id_param("id","File ID"),query("sha256","Exact current source SHA-256",required=True),query("page","Page number",integer(minimum=1),required=True)],
 responses=dict([("200",{"description":"Private no-store bounded PNG page","content":{"image/png":{"schema":{"type":"string","format":"binary"}}}}),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"]),resp("409",ERR["409"])])))
add("GET","/api/files/{id}/preview/pdf/pages",operation("Count PDF pages for image-based preview without browser PDF plug-in","Files","pdfPreviewPages",security=SESSION,
 params=[id_param("id","File ID"),query("sha256","Exact current SHA-256",required=True)],
 responses=dict([json_ok(obj({"pageCount":integer(minimum=1)},required=["pageCount"]),"Current authorized PDF page count"),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"]),resp("409",ERR["409"])])))
add("GET","/api/files/{id}/preview/pdf/page",operation("Render PDF page as isolated PNG with preview-only permission","Files","pdfPreviewPage",security=SESSION,
 params=[id_param("id","File ID"),query("sha256","Exact current SHA-256",required=True),query("page","Page number",integer(minimum=1),required=True),query("revision","Signature revision; omitted means latest",integer(minimum=0))],
 responses=dict([("200",{"description":"Private no-store bounded PNG page","content":{"image/png":{"schema":{"type":"string","format":"binary"}}}}),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"]),resp("409",ERR["409"])])))
add("POST","/api/files/{id}/convert-for-signing",operation("Verify source DOCX download and folder upload permission then persist a separate signing-ready PDF file","Files","convertDOCXForSigning",security=SESSION,
 params=[id_param("id","Source DOCX file")],
 request={"application/json":{"schema":obj({"expectedSeq":integer(minimum=1),"expectedSha256":string(),"idempotencyKey":string()},required=["expectedSeq","expectedSha256","idempotencyKey"])}},
 responses=dict([("201",{"description":"Independent PDF file created","content":{"application/json":{"schema":obj({"ok":boolean(),"data":obj({"fileId":string(),"versionSeq":integer(),"sha256":string(),"name":string()},required=["fileId","versionSeq","sha256","name"])},required=["ok","data"])}}}),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"]),resp("409",ERR["409"])])))

# --- Document signatures and company seals ---
schema("SealAsset",obj({"id":string(),"kind":string(),"name":string(),"ownerId":string(),"ownerName":string(),"grantedUserIds":arr(string()),"createdBy":string(),"sha256":string(),"active":boolean(),"createdAt":timestamp()},required=["id","kind","name","createdBy","sha256","active"]))
schema("FileSealMark",obj({"id":string(),"fileId":string(),"versionSeq":integer(),"fileSha256":string(),"assetId":string(),"assetSha256":string(),"assetName":string(),"assetKind":string(),"signerId":string(),"signerName":string(),"pageNumber":integer(),"x":{"type":"number"},"y":{"type":"number"},"width":{"type":"number"},"height":{"type":"number"},"angleDegrees":{"type":"number","minimum":-180,"maximum":180},"createdAt":timestamp()},required=["id","fileId","versionSeq","fileSha256","assetId","assetSha256","signerId","pageNumber","x","y","width","height"]))
seal_bin={"description":"Permission-gated immutable PNG image; private no-store.","content":{"image/png":{"schema":{"type":"string","format":"binary"}}}}
add("GET","/api/seals",operation("List available signature and seal assets","Seals","listSealAssets",security=SESSION,
 responses=dict([json_ok(arr(ref("SealAsset")),"Admin inventory or caller-authorized assets"),resp("401",ERR["401"]),resp("403",ERR["403"])])))
add("POST","/api/seals",operation("Admin import of an immutable PNG personal signature or company seal","Seals","createSealAsset",security=SESSION,
 request={"application/json":{"schema":obj({"kind":string(),"name":string(),"ownerId":string(),"pngBase64":string()},required=["kind","name","pngBase64"])}},
 responses=dict([("201",{"description":"New immutable seal asset"}),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"])])))
add("POST","/api/seals/bulk",operation("Administrator-only, atomic import of bounded ZIP with SHA-256-verified signature assets and owner login mapping","Seals","importSealBundle",security=SESSION,
 request={"application/zip":{"schema":{"type":"string","format":"binary"}}},
 responses=dict([json_ok(obj({"created":integer(),"existing":integer(),"total":integer()},required=["created","existing","total"]),"Atomic import result; identical previously imported images are skipped"),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"])])))
add("POST","/api/seals/{id}/manage",operation("Admin bind, grant, revoke or retire a seal","Seals","manageSealAsset",security=SESSION,
 params=[id_param("id","Seal ID")],request={"application/json":{"schema":obj({"action":string(),"userId":string()},required=["action"])}},
 responses=dict([json_ok(obj({"updated":string()}),"Updated"),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("GET","/api/seals/{id}/image",operation("Access assigned or authorized seal image","Seals","sealImage",security=SESSION,
 params=[id_param("id","Seal ID")],responses=dict([("200",seal_bin),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("GET","/api/files/{id}/seals/used",operation("Find active seal assets in current signing revision, including equivalent image digests","Seals","usedFileSeals",security=SESSION,
 params=[id_param("id","File ID")],
 responses=dict([json_ok(arr(string()),"Assets unavailable for repeated application to this file"),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("GET","/api/files/{id}/seals",operation("List immutable version-anchored signing evidence","Seals","listFileSealMarks",security=SESSION,
 params=[id_param("id","File ID"),query("version","Version sequence",integer(minimum=1),required=True),query("revision","Signature revision",integer(minimum=0))],
 responses=dict([json_ok(arr(ref("FileSealMark")),"Version signature evidence"),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("POST","/api/files/{id}/seals",operation("Append version-specific evidence; personal signatures require login password, company seals use granted session permissions","Seals","signFileSeal",security=SESSION,
 params=[id_param("id","File ID")],
 request={"application/json":{"schema":obj({"assetId":string(),"versionSeq":integer(),"fileSha256":string(),"password":string(),"pageNumber":integer(),"x":{"type":"number"},"y":{"type":"number"},"width":{"type":"number"},"height":{"type":"number"},"angleDegrees":{"type":"number","minimum":-180,"maximum":180}},required=["assetId","versionSeq","fileSha256","pageNumber","x","y","width","height"])}},
 responses=dict([("201",{"description":"New append-only mark"}),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"]),resp("409",ERR["409"])])))
add("POST","/api/files/{id}/seals/batch",operation("Atomically apply up to twenty different authorized personal signatures or company seals on one immutable PDF version; verify the login password only when personal signatures are included","Seals","signFileSealsBatch",security=SESSION,
 params=[id_param("id","PDF file ID")],
 request={"application/json":{"schema":obj({"password":string(),"versionSeq":integer(minimum=1),"fileSha256":string(),"placements":arr(obj({"assetId":string(),"pageNumber":integer(minimum=1),"x":{"type":"number"},"y":{"type":"number"},"width":{"type":"number"},"height":{"type":"number"},"angleDegrees":{"type":"number","minimum":-180,"maximum":180}},required=["assetId","pageNumber","x","y","width","height"]))},required=["versionSeq","fileSha256","placements"])}},
 responses=dict([("201",{"description":"All append-only signature evidence committed atomically; true operator and asset owner audited separately","content":{"application/json":{"schema":obj({"ok":boolean(),"data":arr(ref("FileSealMark"))},required=["ok","data"])}}}),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"]),resp("409",ERR["409"])])))
add("GET","/api/files/{id}/seals/page",operation("Permission-gated PDF page image for exact seal placement","Seals","fileSealPageImage",security=SESSION,
 params=[id_param("id","File ID"),query("version","Version",integer(minimum=1),required=True),query("page","Page",integer(minimum=1),required=True),query("sha256","Exact file SHA",required=True)],
 responses=dict([("200",seal_bin),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("GET","/api/files/{id}/seals/{mid}/image",operation("Render seal image from authorized file signing evidence","Seals","fileSealMarkImage",security=SESSION,
 params=[id_param("id","File ID"),id_param("mid","Mark ID")],
 responses=dict([("200",seal_bin),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))

add("GET","/api/files/{id}/seals/export",operation("Export actual visually stamped PDF derivative for a signed immutable version","Seals","exportFileSealPDF",security=SESSION,
 params=[id_param("id","File ID"),query("version","Signed file version",integer(minimum=1),required=True),query("revision","Signature revision; omitted means latest",integer(minimum=0))],
 responses=dict([("200",{"description":"Download separate signed visual PDF; original file bytes stay immutable.","content":{"application/pdf":{"schema":{"type":"string","format":"binary"}}}}),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"]),resp("409",ERR["409"])])))


schema("SealRevision",obj({"id":string(),"fileId":string(),"versionSeq":integer(),"revision":integer(minimum=0),"markCount":integer(minimum=0),"action":string(),"actorId":string(),"actorName":string(),"restoredFrom":integer(minimum=0),"createdAt":timestamp()},required=["fileId","versionSeq","revision","markCount","action"]))
add("GET","/api/files/{id}/seals/revisions",operation("List immutable visual signing snapshots; revision zero is the original unsigned PDF","Seals","sealRevisionHistory",security=SESSION,
 params=[id_param("id","File ID"),query("version","Source file version",integer(minimum=1),required=True)],
 responses=dict([json_ok(obj({"current":integer(minimum=0),"revisions":arr(ref("SealRevision"))},required=["current","revisions"]),"Full signature revision timeline"),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("POST","/api/files/{id}/seals/restore",operation("Admin restores an older signature snapshot as a new append-only revision, verifying their own password","Seals","restoreSealRevision",security=SESSION,
 params=[id_param("id","PDF file ID")],request={"application/json":{"schema":obj({"versionSeq":integer(minimum=1),"fileSha256":string(),"expectedRevision":integer(minimum=0),"targetRevision":integer(minimum=0),"password":string()},required=["versionSeq","fileSha256","expectedRevision","targetRevision","password"])}},
 responses=dict([("201",{"description":"New immutable signing revision created; source and evidence unchanged","content":{"application/json":{"schema":obj({"ok":boolean(),"data":ref("SealRevision")},required=["ok","data"])}}}),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"]),resp("409",ERR["409"])])))

add("POST","/api/files/{id}/seals/marks/revoke",operation("Selectively revoke any authorized existing company seal or personal signature by mark ID; signature deletion needs a password, company-only deletion does not. Original evidence stays immutable.","Seals","revokeFileMarks",security=SESSION,
 params=[id_param("id","Signed PDF file ID")],
 request={"application/json":{"schema":obj({"versionSeq":integer(minimum=1),"fileSha256":string(),"expectedRevision":integer(minimum=1),"markIds":arr(string()),"password":string()},required=["versionSeq","fileSha256","expectedRevision","markIds"])}},
 responses=dict([("201",{"description":"New audited signing revision without only the selected stamps and signatures; older evidence retained","content":{"application/json":{"schema":obj({"ok":boolean(),"data":ref("SealRevision")},required=["ok","data"])}}}),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"]),resp("409",ERR["409"])])))

# --- Approvals ---
schema("ApprovalPage",obj({"items":arr(ref("Approval")),"nextCursor":string(),"hasMore":boolean(),"pendingCount":integer(minimum=0)},required=["items","nextCursor","hasMore","pendingCount"]))
schema("ApprovalNotificationPage",obj({"items":arr(ref("ApprovalNotification")),"nextCursor":integer(minimum=0),"hasMore":boolean(),"unreadCount":integer(minimum=0)},required=["items","nextCursor","hasMore","unreadCount"]))
add("GET", "/api/approvals", operation("List approvals visible to the caller", "Workflow", "listApprovals", security=SESSION,
    params=[query("scope", "inbox = my pending; mine = requested by me; all_pending = admin only.", {"type": "string", "enum": ["mine", "inbox", "all_pending"]}),query("limit","Page size 1–100. Omit for legacy array response.",integer(minimum=1)),query("cursor","Last approval ID from the previous page.")],
    responses=dict([json_ok({"oneOf":[arr(ref("Approval")),ref("ApprovalPage")]},"Legacy array, or keyset page when limit is supplied."), resp("401", ERR["401"]), resp("403", ERR["403"])])))

add("GET","/api/approvals/{id}",operation("Get an approval record, including completed approval history, for a participant or admin","Workflow","getApprovalDetail",security=SESSION,
 params=[id_param("id","Approval ID")],
 responses=dict([json_ok(ref("Approval"),"Approval detail."),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))

add("GET","/api/approvals/{id}/draft",operation("Download exact pending proposal bytes (participant with file download permission)","Workflow","downloadApprovalDraft",security=SESSION,
 params=[id_param("id","Approval ID")],
 responses=dict([("200",{"description":"Pending draft bytes. Attachment only; private no-store.","content":{"application/octet-stream":{"schema":{"type":"string","format":"binary"}}}}),
                 resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))


add("GET","/api/approvals/{id}/draft/preview",operation("Preview a pending approval payload with participant/download/preview checks","Workflow","previewApprovalDraft",security=SESSION,
 params=[id_param("id","Approval ID")],
 responses=dict([json_ok(ref("Preview"),"Bounded staged-content preview."),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("GET","/api/approvals/{id}/draft/media",operation("Stream signature-verified staged media with approval permissions","Workflow","previewApprovalDraftMedia",security=SESSION,
 params=[id_param("id","Approval ID")],
 responses=dict([("200",{"description":"Inline passive media with no-store and range support","content":{"application/octet-stream":{"schema":{"type":"string","format":"binary"}}}}),
                 resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("GET","/api/approvals/{id}/draft/compare",operation("Bounded base-versus-pending content comparison","Workflow","compareApprovalDraft",security=SESSION,
 params=[id_param("id","Approval ID")],
 responses=dict([json_ok(ref("VersionComparison"),"Immutable staged revision compared to approval base version."),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))

add("GET","/api/approvals/{id}/history",operation("Read immutable per-step approval activity (participant or admin)","Workflow","approvalHistory",security=SESSION,
 params=[id_param("id","Approval ID")],
 responses=dict([json_ok(arr(ref("ApprovalEvent")),"Ordered approval events."),resp("401",ERR["401"]),resp("403",ERR["403"]),resp("404",ERR["404"])])))
add("GET","/api/approvals/notifications",operation("Read recipient-scoped approval notifications with accurate unread count","Workflow","approvalNotifications",security=SESSION,
 params=[query("limit","Page size 1–100. Omit for legacy array response.",integer(minimum=1)),query("before","ID cursor; only older notifications are returned.",integer(minimum=0))],
 responses=dict([json_ok({"oneOf":[arr(ref("ApprovalNotification")),ref("ApprovalNotificationPage")]},"Legacy array or keyset page with unreadCount."),resp("401",ERR["401"])])))
add("POST","/api/approvals/notifications/{id}/read",operation("Mark own approval notification read (idempotent)","Workflow","readApprovalNotification",security=SESSION,
 params=[id_param("id","Notification ID")],
 responses=dict([json_ok(obj({"read":integer()}),"Recipient-owned receipt."),resp("400",ERR["400"]),resp("401",ERR["401"]),resp("404",ERR["404"])])))

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
    responses=dict([json_ok(obj({"configured": {"type": "boolean", "enum": [True]}, "approverId": string(), "approverIds":arr(string()), "enabled": boolean()}, required=["configured", "approverId", "approverIds", "enabled"]), "Saved policy."),
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
    params=[query("scope", "received: active shares targeting current user/groups; sent: created by administrator.", {"type": "string", "enum": ["received", "sent"]}, required=True),
            query("limit", "Opt-in keyset paging, 1–100; omitting it returns the legacy array.", {"type": "integer", "minimum": 1, "maximum": 100}),
            query("cursor", "Opaque cursor, only valid with limit.")],
    responses=dict([json_ok({"oneOf": [arr(ref("Share")), obj({"items": arr(ref("Share")), "nextCursor": string()},required=["items","nextCursor"])]}, "Legacy array or paged items and nextCursor when limit is present."), resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"])])))

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
    params=[query("limit", "Opt-in keyset paging, 1–100; omitting it returns the legacy array.", {"type": "integer", "minimum": 1, "maximum": 100}),
            query("cursor", "Opaque cursor, only valid with limit."),
            query("view", "Optional 'sidebar': first eight authorized shortcuts.", {"type":"string","enum":["sidebar"]})],
    responses=dict([json_ok({"oneOf": [arr(ref("Favorite")), obj({"items": arr(ref("Favorite")), "nextCursor": string()},required=["items","nextCursor"]),
                                   obj({"items": arr(ref("Favorite"))},required=["items"])]}, "Legacy array, paged list, or sidebar shortcuts. Inaccessible names are masked."), resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"])])))

add("GET", "/api/favorites/notifications", operation("List private favorite-change notifications", "Collaboration", "listFavoriteNotifications", security=SESSION,
    responses=dict([json_ok(obj({"items": arr(ref("FavoriteChangeNotification")), "unreadCount": integer()},required=["items","unreadCount"]), "Recipient-only notifications; no resource names."),
                    resp("401", ERR["401"]), resp("403", ERR["403"])])))

add("POST", "/api/favorites/notifications/{id}/read", operation("Mark favorite notification read", "Collaboration", "readFavoriteNotification", security=SESSION,
    params=[id_param("id", "Notification id.")],
    responses=dict([json_ok(obj({"read": integer()},required=["read"]), "Marked read."), resp("400", ERR["400"]), resp("401", ERR["401"]), resp("404", ERR["404"])])))

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
    params=SEARCH_PARAMS + [query("category","Exact business category."),query("tag","Exact document tag."),query("cursor", "Opaque keyset cursor from nextCursor; an unparseable value restarts at the first page instead of failing the read (WF-30).")],
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
TRASH_PAGE = obj({"items": arr(ref("TrashEntry")), "hasMore": {"type": "boolean"}}, required=["items", "hasMore"])
TRASH_PARAMS = [
    query("search", "Case-insensitive literal substring of the original name (max 120 characters)."),
    query("kind", "Resource kind.", {"type": "string", "enum": ["all", "file", "folder"]}),
    query("deletedBy", "Case-insensitive fragment of the deleter display name or login (max 80 characters)."),
    query("from", "Deletion timestamp lower bound (RFC3339).", {"type": "string", "format": "date-time"}),
    query("sort", "Deletion order.", {"type": "string", "enum": ["recent", "oldest", "name"]}),
    query("offset", "Offset into filtered visible records.", {"type": "integer", "minimum": 0, "maximum": 100000}),
    query("limit", "Page size (defaults to 40 with a query string).", {"type": "integer", "minimum": 1, "maximum": 100}),
]
add("GET", "/api/trash", operation("List trash entries visible to the caller", "Trash", "listTrash", security=SESSION,
    params=TRASH_PARAMS,
    responses=dict([json_ok({"oneOf": [arr(ref("TrashEntry")), TRASH_PAGE]}, "Legacy array without query string; filtered page when query parameters are supplied."),
                    resp("400", ERR["400"]), resp("401", ERR["401"]), resp("403", ERR["403"])])))

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
