package domain
import "time"
type FileReviewComment struct {
 ID int64 `json:"id"`
 FileID string `json:"fileId"`
 VersionSeq int `json:"versionSeq"`
 LineNumber *int `json:"lineNumber,omitempty"`
 Body string `json:"body"`
 AuthorID string `json:"authorId"`
 AuthorName string `json:"authorName"`
 CreatedAt time.Time `json:"createdAt"`
 ResolvedAt *time.Time `json:"resolvedAt,omitempty"`
 ResolvedBy string `json:"resolvedBy,omitempty"`
}
