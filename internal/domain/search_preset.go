package domain

import("encoding/json";"time")

// SearchPreset stores only query conditions; every search still resolves ACLs.
type SearchPreset struct{
 Name string `json:"name"`
 Fields json.RawMessage `json:"fields"`
 CreatedAt time.Time `json:"createdAt"`
}
