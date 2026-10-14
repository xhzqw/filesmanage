package httpx

import (
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"strings"
	"time"
)

// Transport payload builders keep JSON shapes in one place.

func folderPayload(folder domain.Folder) gin.H {
	payload := gin.H{"id": folder.ID, "name": folder.Name, "parentId": folder.ParentID}
	if !folder.UpdatedAt.IsZero() {
		payload["updatedAt"] = folder.UpdatedAt.UTC().Format(time.RFC3339)
	}
	return payload
}

// folderPageItemPayload is the FolderPicker read row: parentId is null for a
// visible root, and disabledReason only appears when the row cannot be selected.
func folderPageItemPayload(item application.FolderPageItem) gin.H {
	payload := gin.H{
		"id": item.ID, "name": item.Name, "parentId": item.ParentID,
		"hasChildren": item.HasChildren, "canSelect": item.CanSelect,
	}
	if item.DisabledReason != "" {
		payload["disabledReason"] = item.DisabledReason
	}
	return payload
}

// folderSearchItemPayload adds the visible path the search read renders.
func folderSearchItemPayload(item application.FolderPageItem) gin.H {
	payload := folderPageItemPayload(item)
	payload["path"] = item.Path
	return payload
}

func filePayload(f domain.File) gin.H {
	payload := gin.H{
		"id": f.ID, "folderId": f.FolderID, "name": f.Name,
		"uploadedBy": f.UploadedBy, "contentType": f.ContentType,
		"sizeBytes": f.SizeBytes, "sha256": f.Sha256,
		"updatedAt": f.UpdatedAt.UTC().Format(time.RFC3339),
	}
	if f.CurrentVersionSeq != nil {
		payload["currentVersionSeq"] = *f.CurrentVersionSeq
	}
	return payload
}

func versionPayload(v domain.FileVersion) gin.H {
	payload := gin.H{
		"versionSeq": v.Seq, "sha256": v.Sha256, "sizeBytes": v.SizeBytes,
		"action": v.Action, "createdBy": v.CreatedByName,
		"createdAt": v.CreatedAt.UTC().Format(time.RFC3339),
	}
	if v.BaseSeq != nil {
		payload["baseSeq"] = *v.BaseSeq
	}
	if v.RollbackTargetSeq != nil {
		payload["rollbackTargetSeq"] = *v.RollbackTargetSeq
	}
	if v.RollbackFromSeq != nil {
		payload["rollbackFromSeq"] = *v.RollbackFromSeq
	}
	if v.Reason != "" {
		payload["reason"] = v.Reason
	}
	return payload
}

func grantPayload(g domain.ACL) gin.H {
	actions := make([]string, 0, len(g.Actions))
	for _, a := range g.Actions {
		actions = append(actions, string(a))
	}
	payload := gin.H{
		"id": g.ID, "folderId": g.FolderID, "subjectKind": g.SubjectKind,
		"subjectId": g.SubjectID, "actions": actions, "scopeOnly": g.ScopeOnly,
		"grantedBy": g.GrantedBy, "grantedByName": g.GrantedByName,
	}
	if g.ExpiresAt != nil {
		payload["expiresAt"] = g.ExpiresAt.UTC().Format(time.RFC3339)
	}
	return payload
}

func trashPayload(t domain.TrashEntry) gin.H {
	payload := gin.H{
		"id": t.ID, "oldName": t.OldName, "deletedBy": t.DeletedBy,
		"deletedByName": t.DeletedName, "deletedAt": t.DeletedAt.UTC().Format(time.RFC3339),
	}
	if t.FileID != nil {
		payload["fileId"] = *t.FileID
	}
	if t.FolderID != nil {
		payload["folderId"] = *t.FolderID
	}
	if t.OldParentID != nil {
		payload["oldParentId"] = *t.OldParentID
	}
	if len(t.OldParentTrail) > 0 {
		payload["oldParentTrail"] = t.OldParentTrail
		parts := make([]string, 0, len(t.OldParentTrail))
		for _, part := range t.OldParentTrail {
			parts = append(parts, part.Name)
		}
		payload["oldParentPath"] = "/" + strings.Join(parts, "/")
	}
	if t.SubtreeCount > 0 {
		payload["subtreeCount"] = t.SubtreeCount
	}
	return payload
}

// parseTime accepts RFC3339 timestamps from transport payloads.
func parseTime(raw string) (time.Time, bool) {
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}, false
	}
	return parsed, true
}

func makeActions(raw []string) []domain.Action {
	out := make([]domain.Action, 0, len(raw))
	for _, a := range raw {
		out = append(out, domain.Action(a))
	}
	return out
}

func restoreRequest(destinationFolderID, newName string) application.RestoreRequest {
	return application.RestoreRequest{DestinationFolderID: destinationFolderID, NewName: newName}
}

func grantRequest(subjectKind, subjectID string, actions []domain.Action, scopeOnly bool, expiresAt *string) application.GrantRequest {
	req := application.GrantRequest{
		SubjectKind: subjectKind, SubjectID: subjectID, Actions: actions, ScopeOnly: scopeOnly,
	}
	if expiresAt != nil && *expiresAt != "" {
		if parsed, err := time.Parse(time.RFC3339, *expiresAt); err == nil {
			req.ExpiresAt = &parsed
		}
	}
	return req
}
