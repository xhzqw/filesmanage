package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"testing"
	"time"
)

func TestCDWBranchCallbackJWTRequiresMatchingDocumentKey(t *testing.T) {
	s := New(nil, nil).WithOffice(OfficeConfig{Secret: "cdw-test-secret"})
	p := EditorCallbackPayload{Key: "cdwkey_123", Status: domain.CallbackStatusForceSave, URL: "http://editor.example/cache.docx"}
	cases := []struct {
		name   string
		claims map[string]any
	}{
		{"source token is not callback authorization", map[string]any{"purpose": "cdw-branch-source", "document": map[string]any{"key": p.Key}}},
		{"cross-session callback", map[string]any{"key": "cdwkey_attacker"}},
		{"payload status mismatch", map[string]any{"payload": map[string]any{"key": p.Key, "status": 2}}},
		{"payload URL mismatch", map[string]any{"payload": map[string]any{"key": p.Key, "status": 6, "url": "http://editor.example/other"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			token, err := signJWT(s.office.Secret, tc.claims, time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.CDWHandleBranchCallback(context.Background(), token, p); !errors.Is(err, domain.ErrUnauthorized) {
				t.Fatalf("callback accepted JWT with wrong purpose/key/payload: %v", err)
			}
		})
	}
}
func TestCDWValidOperationKey(t *testing.T) {
	for _, key := range []string{"", "short", "bad key", "非法-key-123"} {
		if validCDWOperationKey(key) {
			t.Fatalf("invalid key accepted: %q", key)
		}
	}
	for _, key := range []string{"trial-1234", "01234567-abcdef_123"} {
		if !validCDWOperationKey(key) {
			t.Fatalf("valid key rejected: %q", key)
		}
	}
}
