package ports

import "context"

type CDWReadingRoster struct {
	ID            string `json:"id"`
	TargetID      string `json:"targetId"`
	BatchID       string `json:"batchId"`
	FileID        string `json:"fileId"`
	DepartmentID  string `json:"departmentId"`
	DigestSHA256  string `json:"digestSha256"`
	AssignedCount int    `json:"assignedCount"`
}
type CDWReadingAssignment struct {
	ID             string `json:"id"`
	RosterID       string `json:"rosterId"`
	TargetID       string `json:"targetId"`
	BatchID        string `json:"batchId"`
	FileID         string `json:"fileId"`
	FileName       string `json:"fileName"`
	RevisionLabel  string `json:"revisionLabel"`
	ArtifactSHA256 string `json:"artifactSha256"`
	UserID         string `json:"userId"`
	State          string `json:"state"`
}
type CDWReadingConfirmation struct {
	AssignmentID   string `json:"assignmentId"`
	EventID        string `json:"eventId"`
	ActorID        string `json:"actorId"`
	ArtifactSHA256 string `json:"artifactSha256"`
	State          string `json:"state"`
	ConfirmedAt    string `json:"confirmedAt"`
}
type CDWReadingPerson struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}
type CDWReadingStore interface {
	CDWReadingTargetFile(context.Context, string) (string, error)
	CDWReadingAssignmentFile(context.Context, string) (string, error)
	CDWReadingEligible(context.Context, string, string) ([]CDWReadingPerson, error)
	CDWReadingTargetInfo(context.Context, string, string) (CDWReceiptTarget, error)
	CDWReadingRosterInfo(context.Context, string) (CDWReadingRoster, error)
	CDWReadingCreateRoster(context.Context, string, string, string, string, []string, []string, []string) (CDWReadingRoster, error)
	CDWReadingInbox(context.Context, string, int) ([]CDWReadingAssignment, error)
	CDWReadingMarkOpened(context.Context, string, string, string) (bool, error)
	CDWReadingConfirm(context.Context, string, string, string, string) (CDWReadingConfirmation, error)
	CDWReadingSource(context.Context, string, string) (CDWBranchSource, error)
	CDWReadingEvent(context.Context, string, string, string, string, any) error
}
