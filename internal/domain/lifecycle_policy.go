package domain

// LifecyclePolicy supplies optional defaults to future releases and archives.
// Zero means 'no default', rather than a number of days in the past.
type LifecyclePolicy struct {
 DueDays int `json:"dueDays"`
 RetentionDays int `json:"retentionDays"`
}

// LifecyclePolicyView exposes the effective resolution and source.
type LifecyclePolicyView struct {
 LifecyclePolicy
 SourceKind string `json:"sourceKind"`
 SourceID string `json:"sourceId"`
 CanManage bool `json:"canManage"`
}
