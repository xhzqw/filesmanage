package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"strings"
	"testing"
)

// Revoke/restore is more privileged than ordinary file preview or signing.
func TestSealRevisionRestoreRequiresAdminAndConsistentBasis(t *testing.T) {
	service := &Service{}
	request := struct {
		seq, expected, target int
		sha, password         string
	}{1, 1, 0, strings.Repeat("a", 64), "placeholder"}
	_, err := service.RestoreSealRevision(context.Background(), domain.User{ID: "member", IsAdmin: false}, "file", request.seq, request.sha, request.expected, request.target, request.password)
	if !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non-admin reached restoration: %v", err)
	}
	admin := domain.User{ID: "admin", Login: "admin", IsAdmin: true}
	bad := []struct {
		label                 string
		seq, expected, target int
		sha, password         string
	}{
		{"no_source_version", 0, 1, 0, request.sha, request.password},
		{"missing_hash", 1, 1, 0, "x", request.password},
		{"negative_basis", 1, -1, 0, request.sha, request.password},
		{"future_target", 1, 1, 2, request.sha, request.password},
		{"negative_target", 1, 1, -1, request.sha, request.password},
		{"empty_password", 1, 1, 0, request.sha, ""},
	}
	for _, item := range bad {
		t.Run(item.label, func(t *testing.T) {
			_, err := service.RestoreSealRevision(context.Background(), admin, "file", item.seq, item.sha, item.expected, item.target, item.password)
			if !errors.Is(err, domain.ErrInvalidInput) {
				t.Fatalf("invalid restoration reached DB: %v", err)
			}
		})
	}
}
