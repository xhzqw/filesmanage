package application

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"strings"
	"testing"
)

func TestBatchSignValidatesEveryMarkBeforeOpeningTransaction(t *testing.T) {
	service := &Service{}
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	base := SealPlacement{AssetID: "asset-1", Password: "unit-password", VersionSeq: 1, FileSha256: strings.Repeat("a", 64),
		PageNumber: 1, X: .25, Y: .35, Width: .2, Height: .1}
	other := base
	other.AssetID = "asset-2"
	other.X = .6
	invalid := []struct {
		name    string
		entries []SealPlacement
	}{
		{"empty", nil},
		{"identical_assets", []SealPlacement{base, base}},
		{"inconsistent_file_sha", func() []SealPlacement {
			p := other
			p.FileSha256 = strings.Repeat("b", 64)
			return []SealPlacement{base, p}
		}()},
		{"inconsistent_file_version", func() []SealPlacement { p := other; p.VersionSeq = 2; return []SealPlacement{base, p} }()},
		{"inconsistent_password", func() []SealPlacement { p := other; p.Password = "different"; return []SealPlacement{base, p} }()},
		{"out_of_page", func() []SealPlacement { p := other; p.X = .95; return []SealPlacement{base, p} }()},
		{"bad_angle", func() []SealPlacement { p := other; p.AngleDegrees = 190; return []SealPlacement{base, p} }()},
		{"over_max", func() []SealPlacement {
			xs := make([]SealPlacement, 21)
			for i := range xs {
				xs[i] = base
			}
			return xs
		}()},
	}
	for _, tc := range invalid {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := service.SignFileBatch(context.Background(), admin, "file", tc.entries); !errors.Is(err, domain.ErrInvalidInput) {
				t.Fatalf("partial or malformed batch reached transaction: %v", err)
			}
		})
	}
}
