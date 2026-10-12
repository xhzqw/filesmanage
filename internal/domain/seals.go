package domain

import "time"

type SealUserPermission struct {
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName"`
	CanSign     bool   `json:"canSign"`
	CanStamp    bool   `json:"canStamp"`
}

// SealAsset is a private, immutable PNG. A personal asset without an owner
// stays in the admin-only import queue and cannot be used to sign.
type SealAsset struct {
	ID             string    `json:"id"`
	Kind           string    `json:"kind"`
	Name           string    `json:"name"`
	OwnerID        string    `json:"ownerId,omitempty"`
	OwnerName      string    `json:"ownerName,omitempty"`
	GrantedUserIDs []string  `json:"grantedUserIds,omitempty"`
	CreatedBy      string    `json:"createdBy"`
	Sha256         string    `json:"sha256"`
	Active         bool      `json:"active"`
	CreatedAt      time.Time `json:"createdAt"`
}

type FileSealMark struct {
	ID           string    `json:"id"`
	FileID       string    `json:"fileId"`
	VersionSeq   int       `json:"versionSeq"`
	FileSha256   string    `json:"fileSha256"`
	AssetID      string    `json:"assetId"`
	AssetSha256  string    `json:"assetSha256"`
	AssetName    string    `json:"assetName"`
	AssetKind    string    `json:"assetKind"`
	SignerID     string    `json:"signerId"`
	SignerName   string    `json:"signerName"`
	PageNumber   int       `json:"pageNumber"`
	X            float64   `json:"x"`
	Y            float64   `json:"y"`
	Width        float64   `json:"width"`
	Height       float64   `json:"height"`
	AngleDegrees float64   `json:"angleDegrees"`
	CreatedAt    time.Time `json:"createdAt"`
}
