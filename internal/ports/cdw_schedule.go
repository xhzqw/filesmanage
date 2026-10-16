package ports

import "context"

type CDWActivationSchedule struct {
	ReleaseID       string   `json:"releaseId"`
	SponsorID       string   `json:"sponsorId"`
	Status          string   `json:"status"`
	Revision        int64    `json:"revision"`
	ReleaseRevision int64    `json:"releaseRevision"`
	NextAttemptAt   string   `json:"nextAttemptAt"`
	Attempts        int64    `json:"attempts"`
	LastBlockers    []string `json:"lastBlockers"`
	LastError       string   `json:"lastError,omitempty"`
}
type CDWDueActivation struct {
	ReleaseID       string
	SponsorID       string
	LeaseToken      string
	ReleaseRevision int64
}
type CDWActivationScheduleStore interface {
	CDWScheduleGet(context.Context, string) (CDWActivationSchedule, error)
	CDWScheduleConfigure(context.Context, string, string, int64, bool) (CDWActivationSchedule, error)
	CDWScheduleVerifyLease(context.Context, string, string, string) (bool, error)
	CDWScheduleFinish(context.Context, string, string, string, []string) (bool, error)
}
