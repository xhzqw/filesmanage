package domain
import "time"
type FileMetadata struct {
 FileID string `json:"fileId"`
 Category string `json:"category"`
 Description string `json:"description"`
 Tags []string `json:"tags"`
 UpdatedBy string `json:"updatedBy"`
 UpdatedAt time.Time `json:"updatedAt"`
}
