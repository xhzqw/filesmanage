package domain
import "time"
// A session is private to its owner. Only committed results are replayed.
type ResumableUpload struct{
 ID string `json:"id"`
 OwnerID string `json:"-"`
 FolderID string `json:"folderId"`
 FileName string `json:"fileName"`
 ContentType string `json:"-"`
 ExpectedSize int64 `json:"size"`
 ExpectedSHA256 string `json:"-"`
 OperationKey string `json:"-"`
 Received int64 `json:"received"`
 State string `json:"state"`
 ResultJSON []byte `json:"-"`
 ExpiresAt time.Time `json:"expiresAt"`
}
