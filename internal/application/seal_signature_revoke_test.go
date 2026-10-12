package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"strings"
	"testing"
)

func TestRemoveSignaturesRejectsMalformedRequestsBeforeDB(t *testing.T) {
	svc := &Service{}
	admin := domain.User{ID: "admin", IsAdmin: true}
	basis := strings.Repeat("a", 64)
	cases := []struct {
		name          string
		seq, rev      int
		sha, password string
		marks         []string
	}{
		{"missing_password", 1, 1, basis, "", []string{"mark1"}},
		{"bad_seq", 0, 1, basis, "pass", []string{"mark1"}},
		{"bad_sha", 1, 1, "bad", "pass", []string{"mark1"}},
		{"no_revision", 1, 0, basis, "pass", []string{"mark1"}},
		{"empty_marks", 1, 1, basis, "pass", nil},
		{"duplicate_marks", 1, 1, basis, "pass", []string{"mark1", "mark1"}},
		{"oversized_password", 1, 1, basis, strings.Repeat("x", 1025), []string{"mark1"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.RevokeFileSignatures(context.Background(), admin, "file", tc.seq, tc.sha, tc.rev, tc.marks, tc.password)
			if !errors.Is(err, domain.ErrInvalidInput) {
				t.Fatalf("invalid revoke reached persistence: %v", err)
			}
		})
	}
}

func TestSignatureRemovalOnlyPersonalAndAuthorized(t *testing.T) {
	active := []domain.FileSealMark{
		{ID: "personal-a", AssetKind: "personal", SignerID: "alice"},
		{ID: "company", AssetKind: "company", SignerID: "alice"},
		{ID: "personal-b", AssetKind: "personal", SignerID: "bob"},
	}
	remove := func(items ...string) map[string]bool {
		out := make(map[string]bool)
		for _, item := range items {
			out[item] = true
		}
		return out
	}
	remaining, err := filterSignatureRemoval(domain.User{ID: "alice"}, active, remove("personal-a"))
	if err != nil || len(remaining) != 2 || remaining[0] != "company" || remaining[1] != "personal-b" {
		t.Fatalf("authorized targeted removal changed other marks: %v, %v", remaining, err)
	}
	for _, selection := range [][]string{{"company"}, {"personal-b"}} {
		if _, err := filterSignatureRemoval(domain.User{ID: "alice"}, active, remove(selection...)); !errors.Is(err, domain.ErrForbidden) {
			t.Errorf("ordinary user could remove forbidden marks %v: %v", selection, err)
		}
	}
	if _, err := filterSignatureRemoval(domain.User{ID: "alice", IsAdmin: true}, active, remove("company")); !errors.Is(err, domain.ErrForbidden) {
		t.Fatal("company stamp must not be removable through signature endpoint")
	}
	if _, err := filterSignatureRemoval(domain.User{ID: "alice", IsAdmin: true}, active, remove("personal-b")); err != nil {
		t.Fatalf("admin cannot remove personal signature: %v", err)
	}
	if _, err := filterSignatureRemoval(domain.User{ID: "alice", IsAdmin: true}, active, remove("stale")); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("stale mark selection not rejected: %v", err)
	}
}
