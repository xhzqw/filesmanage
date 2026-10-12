package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"strings"
	"testing"
)

func TestRemoveMarksRejectsMalformedRequestsBeforeDB(t *testing.T) {
	svc := &Service{}
	actor := domain.User{ID: "admin", IsAdmin: true}
	sha := strings.Repeat("a", 64)
	cases := []struct {
		name          string
		seq, rev      int
		sha, password string
		marks         []string
	}{
		{"bad_seq", 0, 1, sha, "", []string{"mark1"}},
		{"bad_sha", 1, 1, "bad", "", []string{"mark1"}},
		{"no_revision", 1, 0, sha, "", []string{"mark1"}},
		{"empty_marks", 1, 1, sha, "", nil},
		{"duplicate_marks", 1, 1, sha, "", []string{"mark1", "mark1"}},
		{"oversized_password", 1, 1, sha, strings.Repeat("x", 1025), []string{"mark1"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.RevokeFileMarks(context.Background(), actor, "file", tc.seq, tc.sha, tc.rev, tc.marks, tc.password)
			if !errors.Is(err, domain.ErrInvalidInput) {
				t.Fatalf("invalid revoke reached DB: %v", err)
			}
		})
	}
}

func TestSelectiveSignatureAndSealRemovalPermissionsAndPasswordRules(t *testing.T) {
	active := []domain.FileSealMark{
		{ID: "personal-a", AssetKind: "personal", SignerID: "alice"},
		{ID: "company-a", AssetKind: "company", SignerID: "alice"},
		{ID: "personal-b", AssetKind: "personal", SignerID: "bob"},
		{ID: "company-b", AssetKind: "company", SignerID: "bob"},
	}
	alice := domain.User{ID: "alice"}
	admin := domain.User{ID: "admin", IsAdmin: true}
	stamp := domain.SealUserPermission{CanStamp: true}
	remove := func(ids ...string) map[string]bool {
		m := make(map[string]bool)
		for _, id := range ids {
			m[id] = true
		}
		return m
	}
	cases := []struct {
		name             string
		actor            domain.User
		permission       domain.SealUserPermission
		ids              []string
		remaining        []string
		passwordRequired bool
		wantErr          error
	}{
		{"one_company", alice, stamp, []string{"company-a"}, []string{"personal-a", "personal-b", "company-b"}, false, nil},
		{"one_personal", alice, stamp, []string{"personal-a"}, []string{"company-a", "personal-b", "company-b"}, true, nil},
		{"mixed", alice, stamp, []string{"company-a", "personal-a"}, []string{"personal-b", "company-b"}, true, nil},
		{"admin_company", admin, domain.SealUserPermission{}, []string{"company-b"}, []string{"personal-a", "company-a", "personal-b"}, false, nil},
		{"admin_mixed", admin, domain.SealUserPermission{}, []string{"company-b", "personal-a"}, []string{"company-a", "personal-b"}, true, nil},
		{"no_stamp_permission", alice, domain.SealUserPermission{}, []string{"company-a"}, nil, false, domain.ErrForbidden},
		{"other_signature", alice, stamp, []string{"personal-b"}, nil, false, domain.ErrForbidden},
		{"other_stamp", alice, stamp, []string{"company-b"}, nil, false, domain.ErrForbidden},
		{"missing_mark", admin, stamp, []string{"stale"}, nil, false, domain.ErrVersionConflict},
		{"mixed_with_forbidden", alice, stamp, []string{"personal-a", "company-b"}, nil, false, domain.ErrForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			remaining, needsPassword, err := filterMarkRemoval(tc.actor, tc.permission, active, remove(tc.ids...))
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("error=%v expected=%v", err, tc.wantErr)
			}
			if err != nil {
				return
			}
			if needsPassword != tc.passwordRequired {
				t.Fatalf("password expected=%t got=%t", tc.passwordRequired, needsPassword)
			}
			if len(remaining) != len(tc.remaining) {
				t.Fatalf("remaining=%v expected=%v", remaining, tc.remaining)
			}
			for i := range remaining {
				if remaining[i] != tc.remaining[i] {
					t.Fatalf("other evidence was removed/reordered %v", remaining)
				}
			}
		})
	}
}
