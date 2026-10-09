package httpx

import (
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
)

// Payload builders for collaboration resources.

func sharePayload(s domain.Share) gin.H {
	actions := make([]string, 0, len(s.Actions))
	for _, a := range s.Actions {
		actions = append(actions, string(a))
	}
	payload := gin.H{
		"id": s.ID, "recipientKind": s.RecipientKind, "recipientId": s.RecipientID,
		"recipientName": s.RecipientName, "actions": actions,
		"includeDescendants": s.IncludeDescendants, "createdBy": s.CreatedBy,
		"createdAt": s.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"),
	}
	if s.FileID != nil {
		payload["fileId"] = *s.FileID
		payload["resourceKind"] = "file"
	}
	if s.FolderID != nil {
		payload["folderId"] = *s.FolderID
		payload["resourceKind"] = "folder"
	}
	if s.ResourceName != "" {
		payload["resourceName"] = s.ResourceName
	}
	if s.ExpiresAt != nil {
		payload["expiresAt"] = s.ExpiresAt.UTC().Format("2006-01-02T15:04:05Z")
	}
	payload["revoked"] = s.RevokedAt != nil
	return payload
}

func favoritePayload(f domain.Favorite) gin.H {
	payload := gin.H{
		"id": f.ID, "resourceName": f.ResourceName,
		"unavailable": f.Unavailable,
		"createdAt": f.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"),
	}
	if f.FileID != nil {
		payload["fileId"] = *f.FileID
		payload["kind"] = "file"
	} else if f.FolderID != nil {
		payload["folderId"] = *f.FolderID
		payload["kind"] = "folder"
	}
	return payload
}

// shareRecipientPayload maps one share-target row onto its kind's public shape:
// users carry displayName, groups carry name. Login, department, admin and
// disabled fields stay behind the admin user directory (WF-21).
func shareRecipientPayload(kind string, r application.ShareRecipient) gin.H {
	if kind == "group" {
		return gin.H{"id": r.ID, "name": r.Name}
	}
	return gin.H{"id": r.ID, "displayName": r.Name}
}

func shareDraft(resourceKind, resourceID, recipientKind, recipientID string, actions []domain.Action, includeDescendants bool, expiresAt *string) application.ShareDraft {
	draft := application.ShareDraft{
		ResourceKind: resourceKind, ResourceID: resourceID,
		RecipientKind: recipientKind, RecipientID: recipientID,
		Actions: actions, IncludeDescendants: includeDescendants,
	}
	if expiresAt != nil && *expiresAt != "" {
		if parsed, ok := parseTime(*expiresAt); ok {
			draft.ExpiresAt = &parsed
		}
	}
	return draft
}
