package application

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"image/png"
	"io"
	"strings"
	"unicode/utf8"
)

const maxSealBundleBytes = 6 << 20
const maxSealBundleAssets = 32

type sealBundleManifest struct {
	SchemaVersion int `json:"schemaVersion"`
	Assets        []struct {
		File       string `json:"file"`
		Name       string `json:"name"`
		Kind       string `json:"kind"`
		OwnerLogin string `json:"ownerLogin"`
		OwnerName  string `json:"ownerName"`
		SHA256     string `json:"sha256"`
	} `json:"assets"`
}

type sealBundleAsset struct {
	Name, Kind, OwnerLogin, OwnerName, SHA256 string
	PNG                                       []byte
}
type SealBundleResult struct {
	Created  int `json:"created"`
	Existing int `json:"existing"`
	Total    int `json:"total"`
}

func parseSealBundle(raw []byte) ([]sealBundleAsset, error) {
	if len(raw) < 40 || len(raw) > maxSealBundleBytes {
		return nil, domain.ErrInvalidInput
	}
	reader, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil || len(reader.File) < 2 || len(reader.File) > maxSealBundleAssets+2 {
		return nil, domain.ErrInvalidInput
	}
	lookup := map[string]*zip.File{}
	for _, f := range reader.File {
		if f.FileInfo().IsDir() || f.UncompressedSize64 > 1<<20 || f.Flags&1 != 0 {
			return nil, domain.ErrInvalidInput
		}
		if f.Name != "manifest.json" && f.Name != "README.txt" {
			if !strings.HasPrefix(f.Name, "assets/") || !strings.HasSuffix(f.Name, ".png") ||
				strings.Contains(f.Name, "..") || strings.Count(f.Name, "/") != 1 {
				return nil, domain.ErrInvalidInput
			}
		}
		if _, exists := lookup[f.Name]; exists {
			return nil, domain.ErrInvalidInput
		}
		lookup[f.Name] = f
	}
	manifestEntry := lookup["manifest.json"]
	if manifestEntry == nil || manifestEntry.UncompressedSize64 > 65536 {
		return nil, domain.ErrInvalidInput
	}
	manifestStream, err := manifestEntry.Open()
	if err != nil {
		return nil, domain.ErrInvalidInput
	}
	payload, err := io.ReadAll(io.LimitReader(manifestStream, 65537))
	_ = manifestStream.Close()
	if err != nil || len(payload) > 65536 {
		return nil, domain.ErrInvalidInput
	}
	var manifest sealBundleManifest
	if json.Unmarshal(payload, &manifest) != nil || manifest.SchemaVersion != 1 || len(manifest.Assets) < 1 || len(manifest.Assets) > maxSealBundleAssets {
		return nil, domain.ErrInvalidInput
	}
	output := make([]sealBundleAsset, 0, len(manifest.Assets))
	visitedFile := map[string]bool{}
	visitedDigest := map[string]bool{}
	for _, spec := range manifest.Assets {
		if !utf8.ValidString(spec.Name) || len([]rune(strings.TrimSpace(spec.Name))) < 1 || len([]rune(spec.Name)) > 100 ||
			(spec.Kind != "personal" && spec.Kind != "company") || len(spec.SHA256) != 64 || len(spec.File) > 90 {
			return nil, domain.ErrInvalidInput
		}
		if spec.Kind == "personal" {
			if spec.OwnerLogin == "" || len(spec.OwnerLogin) > 80 {
				return nil, domain.ErrInvalidInput
			}
		} else if spec.OwnerLogin != "" || spec.OwnerName != "" {
			return nil, domain.ErrInvalidInput
		}
		f := lookup[spec.File]
		if f == nil || visitedFile[spec.File] || !strings.HasPrefix(spec.File, "assets/") {
			return nil, domain.ErrInvalidInput
		}
		visitedFile[spec.File] = true
		source, err := f.Open()
		if err != nil {
			return nil, domain.ErrInvalidInput
		}
		rawImage, err := io.ReadAll(io.LimitReader(source, 1048577))
		_ = source.Close()
		if err != nil || len(rawImage) < 30 || len(rawImage) > 1048576 {
			return nil, domain.ErrInvalidInput
		}
		digest := sha256.Sum256(rawImage)
		sum := hex.EncodeToString(digest[:])
		if sum != strings.ToLower(spec.SHA256) || visitedDigest[sum] {
			return nil, domain.ErrInvalidInput
		}
		visitedDigest[sum] = true
		config, err := png.DecodeConfig(bytes.NewReader(rawImage))
		if err != nil || config.Width < 8 || config.Height < 8 || config.Width > 2400 || config.Height > 2400 || config.Width*config.Height > 3000000 {
			return nil, domain.ErrInvalidInput
		}
		if _, err = png.Decode(bytes.NewReader(rawImage)); err != nil {
			return nil, domain.ErrInvalidInput
		}
		output = append(output, sealBundleAsset{Name: strings.TrimSpace(spec.Name), Kind: spec.Kind, OwnerLogin: spec.OwnerLogin, OwnerName: spec.OwnerName, SHA256: sum, PNG: rawImage})
	}
	// Any asset not listed in manifest indicates a malformed or unexpected package.
	for path := range lookup {
		if path != "manifest.json" && path != "README.txt" && !visitedFile[path] {
			return nil, domain.ErrInvalidInput
		}
	}
	return output, nil
}

func (s *Service) ImportSealBundle(ctx context.Context, admin domain.User, raw []byte) (SealBundleResult, error) {
	if !admin.IsAdmin {
		return SealBundleResult{}, domain.ErrForbidden
	}
	assets, err := parseSealBundle(raw)
	if err != nil {
		return SealBundleResult{}, err
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return SealBundleResult{}, err
	}
	defer tx.Rollback(ctx)
	store, err := sealRepository(tx)
	if err != nil {
		return SealBundleResult{}, err
	}
	existing, err := store.ListSeals(ctx)
	if err != nil {
		return SealBundleResult{}, err
	}
	// A matching digest imported previously is idempotent only for the same
	// owner and kind. Never allow a duplicate graphic to impersonate another user.
	byDigest := make(map[string]domain.SealAsset, len(existing))
	for _, a := range existing {
		byDigest[a.Sha256] = a
	}
	result := SealBundleResult{Total: len(assets)}
	for _, entry := range assets {
		var ownerID string
		if entry.Kind == "personal" {
			owner, _, err := tx.UserByLogin(ctx, entry.OwnerLogin)
			if err != nil {
				return SealBundleResult{}, domain.ErrInvalidInput
			}
			if owner.DisabledAt != nil || owner.DisplayName != entry.OwnerName {
				return SealBundleResult{}, domain.ErrInvalidInput
			}
			ownerID = owner.ID
		}
		if old, ok := byDigest[entry.SHA256]; ok {
			if old.Kind != entry.Kind || old.OwnerID != ownerID || !old.Active {
				return SealBundleResult{}, domain.ErrInvalidInput
			}
			result.Existing++
			continue
		}
		asset := domain.SealAsset{ID: NewID("seal"), Name: entry.Name, Kind: entry.Kind, OwnerID: ownerID, CreatedBy: admin.ID, Sha256: entry.SHA256, Active: true}
		if err = store.CreateSeal(ctx, asset, entry.PNG); err != nil {
			return SealBundleResult{}, err
		}
		if err = auditRequired(ctx, tx, admin, "seal.create", "seal", asset.ID, "success", map[string]any{
			"kind": asset.Kind, "name": asset.Name, "ownerId": ownerID, "sha256": asset.Sha256, "source": "admin-verified-bundle-import",
		}); err != nil {
			return SealBundleResult{}, err
		}
		byDigest[entry.SHA256] = asset
		result.Created++
	}
	if err = tx.Commit(ctx); err != nil {
		return SealBundleResult{}, err
	}
	return result, nil
}

var _ ports.SealStore
