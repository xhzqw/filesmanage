package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"image/png"
	"io"
	"math"
	"strings"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"golang.org/x/crypto/bcrypt"
	"rsc.io/pdf"
)

// Signature marks are version-anchored evidence, not CMS/PAdES signatures.
// A separate stamped-PDF export is required for portable document rendering.

func sealRepository(tx ports.Repository) (ports.SealStore, error) {
	store, ok := tx.(ports.SealStore)
	if !ok {
		return nil, errors.New("seal repository unavailable")
	}
	return store, nil
}

func (s *Service) SealAssets(ctx context.Context, actor domain.User) ([]domain.SealAsset, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, err := sealRepository(tx)
	if err != nil {
		return nil, err
	}
	all, err := store.ListSeals(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]domain.SealAsset, 0, len(all))
	for _, a := range all {
		if actor.IsAdmin {
			out = append(out, a)
			continue
		}
		if a.Kind == "company" && !a.Active {
			continue
		}
		if a.Kind == "personal" {
			if a.OwnerID == actor.ID {
				out = append(out, a)
			}
			continue
		}
		granted, grantErr := store.HasSealGrant(ctx, a.ID, actor.ID)
		if grantErr != nil {
			return nil, grantErr
		}
		if granted {
			out = append(out, a)
		}
	}
	return out, nil
}

func (s *Service) CreateSealAsset(ctx context.Context, actor domain.User, kind, name, ownerID string, data []byte) (domain.SealAsset, error) {
	if !actor.IsAdmin {
		// Users may upload their own personal signature, but never a company seal.
		if kind != "personal" || (ownerID != "" && ownerID != actor.ID) {
			return domain.SealAsset{}, domain.ErrForbidden
		}
		ownerID = actor.ID
	}
	kind = strings.TrimSpace(kind)
	name = strings.TrimSpace(name)
	if (kind != "personal" && kind != "company") || len([]rune(name)) < 1 || len([]rune(name)) > 100 || len(data) < 30 || len(data) > 1<<20 {
		return domain.SealAsset{}, domain.ErrInvalidInput
	}
	if kind == "company" && ownerID != "" {
		return domain.SealAsset{}, domain.ErrInvalidInput
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width < 8 || cfg.Height < 8 || cfg.Width > 2400 || cfg.Height > 2400 || cfg.Width*cfg.Height > 3000000 {
		return domain.SealAsset{}, domain.ErrInvalidInput
	}
	// Decode the complete payload; don't trust a valid PNG header with a corrupt body.
	if _, err = png.Decode(bytes.NewReader(data)); err != nil {
		return domain.SealAsset{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.SealAsset{}, err
	}
	defer tx.Rollback(ctx)
	if ownerID != "" {
		org, ok := tx.(ports.OrganizationStore)
		if !ok {
			return domain.SealAsset{}, domain.ErrForbidden
		}
		owner, err := org.UserByID(ctx, ownerID)
		if err != nil {
			return domain.SealAsset{}, notFoundOr(err)
		}
		if owner.DisabledAt != nil {
			return domain.SealAsset{}, domain.ErrForbidden
		}
	}
	store, err := sealRepository(tx)
	if err != nil {
		return domain.SealAsset{}, err
	}
	hash := sha256.Sum256(data)
	a := domain.SealAsset{ID: NewID("seal"), Kind: kind, Name: name, OwnerID: ownerID, CreatedBy: actor.ID, Sha256: hex.EncodeToString(hash[:]), Active: true}
	if err = store.CreateSeal(ctx, a, data); err != nil {
		return domain.SealAsset{}, err
	}
	if err = auditRequired(ctx, tx, actor, "seal.create", "seal", a.ID, "success", map[string]any{"kind": kind, "name": name, "ownerId": ownerID, "sha256": a.Sha256}); err != nil {
		return domain.SealAsset{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.SealAsset{}, err
	}
	return a, nil
}

func (s *Service) ConfigureSeal(ctx context.Context, actor domain.User, id, action, userID string) error {
	if !actor.IsAdmin && ((action != "retire" && action != "rename") || (action == "retire" && userID != "")) {
		return domain.ErrForbidden
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	store, err := sealRepository(tx)
	if err != nil {
		return err
	}
	asset, _, err := store.GetSeal(ctx, id)
	if err != nil {
		return notFoundOr(err)
	}
	if !actor.IsAdmin && (asset.Kind != "personal" || asset.OwnerID != actor.ID) {
		return domain.ErrForbidden
	}
	if !asset.Active {
		return domain.ErrForbidden
	}
	switch action {
	case "bind":
		if asset.Kind != "personal" || asset.OwnerID != "" || userID == "" {
			return domain.ErrInvalidInput
		}
		org, ok := tx.(ports.OrganizationStore)
		if !ok {
			return domain.ErrForbidden
		}
		target, err := org.UserByID(ctx, userID)
		if err != nil {
			return notFoundOr(err)
		}
		if target.DisabledAt != nil {
			return domain.ErrForbidden
		}
		err = store.BindSeal(ctx, id, userID)
	case "grant":
		if asset.Kind != "company" || userID == "" {
			return domain.ErrInvalidInput
		}
		org, ok := tx.(ports.OrganizationStore)
		if !ok {
			return domain.ErrForbidden
		}
		target, err := org.UserByID(ctx, userID)
		if err != nil {
			return notFoundOr(err)
		}
		if target.DisabledAt != nil {
			return domain.ErrForbidden
		}
		err = store.GrantSeal(ctx, id, userID, actor.ID)
	case "revoke":
		if asset.Kind != "company" || userID == "" {
			return domain.ErrInvalidInput
		}
		err = store.RevokeSealGrant(ctx, id, userID)
	case "rename":
		if userID == "" || len([]rune(strings.TrimSpace(userID))) > 100 {
			return domain.ErrInvalidInput
		}
		err = store.RenameSeal(ctx, id, strings.TrimSpace(userID))
	case "retire":
		if userID != "" {
			return domain.ErrInvalidInput
		}
		err = store.RetireSeal(ctx, id)
	default:
		return domain.ErrInvalidInput
	}
	if err != nil {
		return notFoundOr(err)
	}
	if err = auditRequired(ctx, tx, actor, "seal."+action, "seal", id, "success", map[string]any{"userId": userID}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) SealImage(ctx context.Context, actor domain.User, id string) ([]byte, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, err := sealRepository(tx)
	if err != nil {
		return nil, err
	}
	a, data, err := store.GetSeal(ctx, id)
	if err != nil {
		return nil, notFoundOr(err)
	}
	if actor.IsAdmin {
		return data, nil
	}
	if a.Kind == "personal" && a.OwnerID == actor.ID {
		return data, nil
	}
	if !a.Active {
		return nil, domain.ErrForbidden
	}
	if a.Kind == "company" {
		allowed, err := store.HasSealGrant(ctx, id, actor.ID)
		if err != nil {
			return nil, err
		}
		if allowed {
			return data, nil
		}
	}
	return nil, domain.ErrForbidden
}

type SealPlacement struct {
	AssetID      string  `json:"assetId"`
	VersionSeq   int     `json:"versionSeq"`
	FileSha256   string  `json:"fileSha256"`
	Password     string  `json:"password"`
	PageNumber   int     `json:"pageNumber"`
	X            float64 `json:"x"`
	Y            float64 `json:"y"`
	Width        float64 `json:"width"`
	Height       float64 `json:"height"`
	AngleDegrees float64 `json:"angleDegrees"`
}

func normalizedSealPosition(p SealPlacement) bool {
	for _, v := range []float64{p.X, p.Y, p.Width, p.Height} {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return false
		}
	}
	return !math.IsNaN(p.AngleDegrees) && !math.IsInf(p.AngleDegrees, 0) && math.Abs(p.AngleDegrees) <= 180 && math.Abs(p.AngleDegrees-math.Round(p.AngleDegrees*100)/100) < 1e-8 && p.PageNumber >= 1 && p.PageNumber <= 10000 && p.X >= 0 && p.Y >= 0 && p.Width > 0 && p.Height > 0 && p.X+p.Width <= 1.00000001 && p.Y+p.Height <= 1.00000001
}
func (s *Service) SignFile(ctx context.Context, actor domain.User, fileID string, p SealPlacement) (domain.FileSealMark, error) {
	if !normalizedSealPosition(p) || p.VersionSeq < 1 || len(p.AssetID) > 128 || len(p.AssetID) == 0 || len(p.Password) == 0 || len(p.Password) > 1024 || len(p.FileSha256) != 64 {
		return domain.FileSealMark{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return domain.FileSealMark{}, err
	}
	defer tx.Rollback(ctx)
	// Password verification is within the same DB transaction as the signed
	// mark. Never accept a previous browser confirmation or somebody else's password.
	identity, hash, err := tx.UserByLogin(ctx, actor.Login)
	if err != nil || identity.ID != actor.ID || bcrypt.CompareHashAndPassword([]byte(hash), []byte(p.Password)) != nil {
		return domain.FileSealMark{}, ErrInvalidCredentials
	}
	file, err := s.visibleFile(ctx, tx, actor, fileID, domain.ActionPrint)
	if err != nil {
		return domain.FileSealMark{}, err
	}
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return domain.FileSealMark{}, err
	}
	if currentSeq(file) != p.VersionSeq {
		return domain.FileSealMark{}, domain.ErrVersionConflict
	}
	version, err := tx.VersionBySeq(ctx, file.ID, p.VersionSeq)
	if err != nil || version.Sha256 != p.FileSha256 {
		return domain.FileSealMark{}, domain.ErrVersionConflict
	}
	// Only a verified PDF page may receive a positioned document signature.
	if extensionOf(file.Name) != ".pdf" || version.SizeBytes > 20<<20 {
		return domain.FileSealMark{}, domain.ErrInvalidInput
	}
	blob, err := tx.BlobByID(ctx, version.BlobID)
	if err != nil {
		return domain.FileSealMark{}, domain.ErrNotFound
	}
	reader, err := s.blobs.Open(blob.StorageKey)
	if err != nil {
		return domain.FileSealMark{}, err
	}
	content, readErr := io.ReadAll(io.LimitReader(reader, (20<<20)+1))
	reader.Close()
	if readErr != nil {
		return domain.FileSealMark{}, readErr
	}
	if int64(len(content)) != version.SizeBytes || len(content) < 8 || !bytes.HasPrefix(content, []byte("%PDF-")) {
		return domain.FileSealMark{}, domain.ErrInvalidInput
	}
	document, parseErr := pdf.NewReader(bytes.NewReader(content), int64(len(content)))
	if parseErr != nil || document.NumPage() < p.PageNumber {
		return domain.FileSealMark{}, domain.ErrInvalidInput
	}
	// Rotation must fit the PDF's actual physical page dimensions, not just
	// its unrotated normalized rectangle.
	dims, dimErr := api.PageDims(ctx, bytes.NewReader(content), nil)
	if dimErr != nil || p.PageNumber > len(dims) || !rotatedSealFits(dims[p.PageNumber-1].Width, dims[p.PageNumber-1].Height, p) {
		return domain.FileSealMark{}, domain.ErrInvalidInput
	}

	store, err := sealRepository(tx)
	if err != nil {
		return domain.FileSealMark{}, err
	}
	asset, _, err := store.GetSeal(ctx, p.AssetID)
	if err != nil {
		return domain.FileSealMark{}, notFoundOr(err)
	}
	permission, err := store.SealUserPermission(ctx, actor.ID)
	if err != nil {
		return domain.FileSealMark{}, notFoundOr(err)
	}
	var hasCompanyGrant bool
	if !actor.IsAdmin && asset.Kind == "company" {
		hasCompanyGrant, err = store.HasSealGrant(ctx, asset.ID, actor.ID)
		if err != nil {
			return domain.FileSealMark{}, err
		}
	}
	if !sealCanApply(actor, asset, permission, hasCompanyGrant) {
		return domain.FileSealMark{}, domain.ErrForbidden
	}
	alreadyUsed, err := store.FileHasSeal(ctx, file.ID, asset.ID)
	if err != nil {
		return domain.FileSealMark{}, err
	}
	if alreadyUsed {
		return domain.FileSealMark{}, domain.ErrNameConflict
	}
	mark := domain.FileSealMark{ID: NewID("mark"), FileID: file.ID, VersionSeq: p.VersionSeq, FileSha256: version.Sha256, AssetID: asset.ID, AssetSha256: asset.Sha256, SignerID: actor.ID, PageNumber: p.PageNumber, X: p.X, Y: p.Y, Width: p.Width, Height: p.Height, AngleDegrees: p.AngleDegrees}
	if err = store.InsertSealMark(ctx, mark); err != nil {
		return domain.FileSealMark{}, err
	}
	if err = auditRequired(ctx, tx, actor, "seal.apply", "file", file.ID, "success", map[string]any{
		"markId": mark.ID, "fileSha256": mark.FileSha256, "versionSeq": mark.VersionSeq, "assetId": mark.AssetID, "assetSha256": mark.AssetSha256, "assetKind": asset.Kind, "assetOwnerId": asset.OwnerID, "performedBy": actor.ID, "adminOverride": actor.IsAdmin && (asset.Kind == "personal" && asset.OwnerID != actor.ID || asset.Kind == "company"), "page": mark.PageNumber, "x": mark.X, "y": mark.Y, "width": mark.Width, "height": mark.Height, "angleDegrees": mark.AngleDegrees,
	}); err != nil {
		return domain.FileSealMark{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.FileSealMark{}, err
	}
	mark.AssetKind = asset.Kind
	mark.AssetName = asset.Name
	mark.SignerName = actor.DisplayName
	mark.CreatedAt = s.now()
	return mark, nil
}

func (s *Service) FileSeals(ctx context.Context, actor domain.User, fileID string, seq int) ([]domain.FileSealMark, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return nil, err
	}
	if seq < 1 {
		return nil, domain.ErrInvalidInput
	}
	if _, err = tx.VersionBySeq(ctx, fileID, seq); err != nil {
		return nil, domain.ErrNotFound
	}
	store, err := sealRepository(tx)
	if err != nil {
		return nil, err
	}
	return store.ListSealMarks(ctx, fileID, seq)
}

func (s *Service) FileSealImage(ctx context.Context, actor domain.User, fileID, markID string) ([]byte, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return nil, err
	}
	store, err := sealRepository(tx)
	if err != nil {
		return nil, err
	}
	mark, err := store.GetSealMark(ctx, fileID, markID)
	if err != nil {
		return nil, notFoundOr(err)
	}
	a, data, err := store.GetSeal(ctx, mark.AssetID)
	if err != nil {
		return nil, notFoundOr(err)
	}
	if a.Sha256 != mark.AssetSha256 {
		return nil, domain.ErrVersionConflict
	}
	return data, nil
}

// Reserve bounded reads for future streamed seal output implementations.
var _ = io.LimitReader
