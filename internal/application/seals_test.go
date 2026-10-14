package application

import (
	"errors"
	"filesmanage/internal/domain"
	"math"
	"strings"
	"testing"
)

func TestSignaturePlacementRejectsOutOfPageAndInvalidNumbers(t *testing.T) {
	baseline := SealPlacement{PageNumber: 1, X: .70, Y: .70, Width: .20, Height: .10}
	if !normalizedSealPosition(baseline) {
		t.Fatal("valid placement rejected")
	}
	invalid := []SealPlacement{
		{PageNumber: 0, X: .7, Y: .7, Width: .2, Height: .1},
		{PageNumber: 10001, X: .7, Y: .7, Width: .2, Height: .1},
		{PageNumber: 1, X: -.1, Y: .7, Width: .2, Height: .1},
		{PageNumber: 1, X: .9, Y: .7, Width: .2, Height: .1},
		{PageNumber: 1, X: .7, Y: .95, Width: .2, Height: .1},
		{PageNumber: 1, X: .7, Y: .7, Width: 0, Height: .1},
		{PageNumber: 1, X: math.NaN(), Y: .7, Width: .2, Height: .1},
		{PageNumber: 1, X: .7, Y: math.Inf(1), Width: .2, Height: .1},
	}
	for i, v := range invalid {
		if normalizedSealPosition(v) {
			t.Fatalf("invalid position %d accepted", i)
		}
	}
}

func TestNonAdminCanOnlyPrepareOwnPersonalSignature(t *testing.T) {
	s := &Service{}
	ordinary := domain.User{ID: "user_one"}
	if _, err := s.CreateSealAsset(nil, ordinary, "personal", "签名", "", []byte("not an image")); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("personal upload must validate image: %v", err)
	}
	if _, err := s.CreateSealAsset(nil, ordinary, "company", "公章", "", nil); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("ordinary cannot upload a company seal: %v", err)
	}
	if _, err := s.CreateSealAsset(nil, ordinary, "personal", "替别人签名", "user_two", nil); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("ordinary cannot assign other's signature: %v", err)
	}
	if err := s.ConfigureSeal(nil, ordinary, "asset", "bind", "user_two"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("ordinary cannot bind a signature for another account: %v", err)
	}
}

func TestSignatureBatchRejectsBadVersionAndOversizedPassword(t *testing.T) {
	s := &Service{}
	invalid := SealPlacement{AssetID: "seal_1", PageNumber: 1, VersionSeq: 1, FileSha256: "wrong", Password: "test", X: .6, Y: .6, Width: .2, Height: .2}
	if _, err := s.SignFile(nil, domain.User{}, "file", invalid); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("invalid version digest: %v", err)
	}
	invalid.FileSha256 = strings.Repeat("a", 64)
	invalid.Password = strings.Repeat("x", 1025)
	if _, err := s.SignFile(nil, domain.User{}, "file", invalid); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("oversized password: %v", err)
	}
}
