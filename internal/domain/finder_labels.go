package domain

// FinderLabel is owned by a user and does not grant any file permissions.
type FinderLabel struct {
	ID        string `json:"id"`
	UserID    string `json:"-"`
	Name      string `json:"name"`
	Color     string `json:"color"`
	SortOrder int    `json:"sortOrder"`
	IsDefault bool   `json:"isDefault"`
}
