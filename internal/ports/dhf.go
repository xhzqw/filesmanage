package ports

import "context"

// DHF is the XMind-derived delivery catalogue, not a second formal approval engine.
type DHFNode struct {
	SourceLine int      `json:"sourceLine"`
	StageNo    int      `json:"stageNo"`
	Depth      int      `json:"depth"`
	Title      string   `json:"title"`
	ParentPath []string `json:"parentPath"`
	IsGroup    bool     `json:"isGroup"`
}
type DHFTemplate struct {
	Name   string    `json:"name"`
	SHA256 string    `json:"sha256"`
	Nodes  []DHFNode `json:"nodes"`
}
type DHFProject struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	OwnerID        string `json:"ownerId"`
	ReviewerID     string `json:"reviewerId"`
	TemplateSHA256 string `json:"templateSha256"`
	Revision       int64  `json:"revision"`
	AcceptedStages int    `json:"acceptedStages"`
	CreatedAt      string `json:"createdAt"`
}
type DHFStage struct {
	StageNo        int    `json:"stageNo"`
	Name           string `json:"name"`
	State          string `json:"state"`
	Revision       int64  `json:"revision"`
	AcceptedBy     string `json:"acceptedBy,omitempty"`
	AcceptedAt     string `json:"acceptedAt,omitempty"`
	BaselineSHA256 string `json:"baselineSha256,omitempty"`
}
type DHFItem struct {
	SourceLine          int      `json:"sourceLine"`
	StageNo             int      `json:"stageNo"`
	ParentPath          []string `json:"parentPath"`
	Title               string   `json:"title"`
	State               string   `json:"state"`
	ApplicabilityReason string   `json:"applicabilityReason"`
	FileID              string   `json:"fileId,omitempty"`
	FileVersionID       string   `json:"fileVersionId,omitempty"`
	FileSHA256          string   `json:"fileSha256,omitempty"`
	SubmittedBy         string   `json:"submittedBy,omitempty"`
	SubmittedAt         string   `json:"submittedAt,omitempty"`
	ReviewedBy          string   `json:"reviewedBy,omitempty"`
	ReviewedAt          string   `json:"reviewedAt,omitempty"`
	ReviewReason        string   `json:"reviewReason"`
	Revision            int64    `json:"revision"`
}
type DHFFileVersion struct {
	ID     string `json:"id"`
	Seq    int    `json:"seq"`
	SHA256 string `json:"sha256"`
}
type DHFProofEvent struct {
	ID             int64  `json:"id"`
	StageNo        int    `json:"stageNo"`
	SourceLine     int    `json:"sourceLine"`
	Action         string `json:"action"`
	ActorID        string `json:"actorId"`
	PayloadText    string `json:"payloadText"`
	PreviousSHA256 string `json:"previousSha256"`
	EventSHA256    string `json:"eventSha256"`
	OccurredAt     string `json:"occurredAt"`
}
type DHFEvent struct {
	ID             int64  `json:"id"`
	StageNo        int    `json:"stageNo"`
	SourceLine     int    `json:"sourceLine"`
	Action         string `json:"action"`
	ActorID        string `json:"actorId"`
	EventSHA256    string `json:"eventSha256"`
	PreviousSHA256 string `json:"previousSha256"`
	OccurredAt     string `json:"occurredAt"`
}
type DHFDetail struct {
	Project DHFProject `json:"project"`
	Stages  []DHFStage `json:"stages"`
	Items   []DHFItem  `json:"items"`
	Events  []DHFEvent `json:"events"`
}
type DHFStore interface {
	DHFCreate(context.Context, DHFProject, []DHFNode) error
	DHFProjects(context.Context, string) ([]DHFProject, error)
	DHFProjectByID(context.Context, string, string, bool) (DHFProject, error)
	DHFDetail(context.Context, string) (DHFDetail, error)
	DHFUserActive(context.Context, string) (bool, error)
	DHFItemByLine(context.Context, string, int) (DHFItem, error)
	DHFUpdateItem(context.Context, string, DHFItem, int64) error
	DHFFileVersion(context.Context, string, string) (string, error)
	DHFFileVersions(context.Context, string) ([]DHFFileVersion, error)
	DHFAcceptStage(context.Context, string, int, string, string) error
	DHFClaim(context.Context, string, string, string) ([]byte, bool, error)
	DHFComplete(context.Context, string, string, string, any) error
	DHFAppendEvent(context.Context, string, int, int, string, string, any) error
}
