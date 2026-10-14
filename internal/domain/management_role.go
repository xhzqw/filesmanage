package domain

import "time"

// ManagementRoleBinding is separate from the nine ACL file actions.
// A scoped permission_admin may manage *direct* grants on one folder only.
type ManagementRoleBinding struct {
	ID             string     `json:"id"`
	UserID         string     `json:"userId"`
	Role           string     `json:"role"`
	ScopeKind      string     `json:"scopeKind"`
	ScopeID        string     `json:"scopeId"`
	AllowedActions []Action   `json:"allowedActions"`
	ExpiresAt      *time.Time `json:"expiresAt,omitempty"`
	GrantedBy      string     `json:"grantedBy"`
	CreatedAt      time.Time  `json:"createdAt"`
	RevokedAt      *time.Time `json:"revokedAt,omitempty"`
}

func (b ManagementRoleBinding) Active(at time.Time) bool {
	return b.RevokedAt == nil && (b.ExpiresAt == nil || b.ExpiresAt.After(at))
}
