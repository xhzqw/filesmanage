package application

import (
	"context"
	"filesmanage/internal/domain"
	"sort"
	"time"
)

// PermissionSource is a transparent explanation of one *applied* source.
// Excluded, expired and out-of-scope grants never appear in this list.
type PermissionSource struct {
	Kind        string          `json:"kind"`
	ResourceID  string          `json:"resourceId"`
	GrantID     string          `json:"grantId,omitempty"`
	SubjectKind string          `json:"subjectKind,omitempty"`
	SubjectID   string          `json:"subjectId,omitempty"`
	Actions     []domain.Action `json:"actions"`
	ScopeOnly   bool            `json:"scopeOnly"`
	Depth       int             `json:"depth"`
	ExpiresAt   *time.Time      `json:"expiresAt,omitempty"`
}

type PermissionExplanation struct {
	SubjectKind      string             `json:"subjectKind"`
	SubjectID        string             `json:"subjectId"`
	FolderID         string             `json:"folderId"`
	SubjectDisabled  bool               `json:"subjectDisabled"`
	SubjectRequiresPasswordChange bool  `json:"subjectRequiresPasswordChange"`
	EffectiveActions []domain.Action    `json:"effectiveActions"`
	Sources          []PermissionSource `json:"sources"`
	EvaluatedAt      time.Time          `json:"evaluatedAt"`
}

var actionOrder = []domain.Action{
	domain.ActionList, domain.ActionPreview, domain.ActionUpload,
	domain.ActionDownload, domain.ActionModify, domain.ActionDelete,
	domain.ActionRename, domain.ActionMove, domain.ActionPrint,
}

func orderedActions(allowed map[domain.Action]bool) []domain.Action {
	result := make([]domain.Action, 0, len(actionOrder))
	for _, a := range actionOrder {
		if allowed[a] {
			result = append(result, a)
		}
	}
	return result
}

func containsGroup(groups []string, id string) bool {
	for _, group := range groups {
		if group == id {
			return true
		}
	}
	return false
}

// ExplainFolderPermissions is a read-only, admin-only view of the SAME
// authorization resolver used by file/folder operations. This first version
// explains a user on one folder; it does not pretend file shares or role
// management are included.
func (s *Service) ExplainFolderPermissions(ctx context.Context, actor domain.User, subjectID, folderID string) (PermissionExplanation, error) {
	if err := s.requireAdmin(actor); err != nil {
		return PermissionExplanation{}, err
	}
	if subjectID == "" || folderID == "" {
		return PermissionExplanation{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return PermissionExplanation{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = s.activeFolder(ctx, tx, folderID); err != nil {
		return PermissionExplanation{}, err
	}
	subject, err := tx.UserByID(ctx, subjectID)
	if err != nil {
		return PermissionExplanation{}, domain.ErrNotFound
	}
	result := PermissionExplanation{
		SubjectKind: "user", SubjectID: subject.ID, FolderID: folderID,
		SubjectDisabled: subject.DisabledAt != nil,
		SubjectRequiresPasswordChange: subject.MustChangePassword,
		EffectiveActions: []domain.Action{}, Sources: []PermissionSource{},
		EvaluatedAt: s.now().UTC(),
	}
	// Neither a disabled account nor a first-sign-in account can use business
	// operations. Do not present hypothetical ACLs as currently usable rights.
	if result.SubjectDisabled || result.SubjectRequiresPasswordChange {
		return result, nil
	}
	allowed, sources, err := s.resolveActionsWithSources(ctx, tx, subject, folderID, true)
	if err != nil {
		return PermissionExplanation{}, err
	}
	result.EffectiveActions = orderedActions(allowed)
	for i := range sources {
		sort.Slice(sources[i].Actions, func(a, b int) bool {
			return sources[i].Actions[a] < sources[i].Actions[b]
		})
	}
	sort.Slice(sources, func(i, j int) bool {
		if sources[i].Depth != sources[j].Depth {
			return sources[i].Depth < sources[j].Depth
		}
		if sources[i].Kind != sources[j].Kind {
			return sources[i].Kind < sources[j].Kind
		}
		return sources[i].GrantID < sources[j].GrantID
	})
	result.Sources = sources
	return result, nil
}
