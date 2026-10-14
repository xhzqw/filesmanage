package domain
type LifecycleStatistics struct{
 Released int64 `json:"released"`
 Archived int64 `json:"archived"`
 DueSoon int64 `json:"dueSoon"`
 Overdue int64 `json:"overdue"`
 Retained int64 `json:"retained"`
}
