package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

func (r *Repository) ListSeals(ctx context.Context) ([]domain.SealAsset, error) {
	rows, err := r.Q.Query(ctx, `SELECT a.id,a.kind,a.name,COALESCE(a.owner_id,''),COALESCE(u.display_name,''),a.created_by,a.sha256,a.retired_at IS NULL,a.created_at,(SELECT COALESCE(array_agg(g.user_id),ARRAY[]::text[]) FROM seal_grants g WHERE g.asset_id=a.id)
 FROM seal_assets a LEFT JOIN users u ON u.id=a.owner_id ORDER BY a.created_at DESC,a.id DESC LIMIT 500`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []domain.SealAsset{}
	for rows.Next() {
		var a domain.SealAsset
		if err = rows.Scan(&a.ID, &a.Kind, &a.Name, &a.OwnerID, &a.OwnerName, &a.CreatedBy, &a.Sha256, &a.Active, &a.CreatedAt, &a.GrantedUserIDs); err != nil {
			return nil, err
		}
		items = append(items, a)
	}
	return items, rows.Err()
}
func (r *Repository) GetSeal(ctx context.Context, id string) (domain.SealAsset, []byte, error) {
	var a domain.SealAsset
	var data []byte
	err := r.Q.QueryRow(ctx, `SELECT a.id,a.kind,a.name,COALESCE(a.owner_id,''),COALESCE(u.display_name,''),a.created_by,a.sha256,a.retired_at IS NULL,a.created_at,a.png_bytes
 FROM seal_assets a LEFT JOIN users u ON u.id=a.owner_id WHERE a.id=$1`, id).Scan(&a.ID, &a.Kind, &a.Name, &a.OwnerID, &a.OwnerName, &a.CreatedBy, &a.Sha256, &a.Active, &a.CreatedAt, &data)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, nil, ports.ErrRowMissing
	}
	return a, data, err
}
func (r *Repository) CreateSeal(ctx context.Context, a domain.SealAsset, data []byte) error {
	var owner any
	if a.OwnerID != "" {
		owner = a.OwnerID
	}
	_, err := r.Q.Exec(ctx, `INSERT INTO seal_assets(id,kind,name,owner_id,created_by,png_bytes,sha256)
 VALUES($1,$2,$3,$4,$5,$6,$7)`, a.ID, a.Kind, a.Name, owner, a.CreatedBy, data, a.Sha256)
	return err
}
func (r *Repository) BindSeal(ctx context.Context, id, userID string) error {
	tag, err := r.Q.Exec(ctx, `UPDATE seal_assets SET owner_id=$2 WHERE id=$1 AND kind='personal' AND owner_id IS NULL AND retired_at IS NULL`, id, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ports.ErrRowMissing
	}
	return nil
}
func (r *Repository) RetireSeal(ctx context.Context, id string) error {
	tag, err := r.Q.Exec(ctx, `UPDATE seal_assets SET retired_at=now() WHERE id=$1 AND retired_at IS NULL`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ports.ErrRowMissing
	}
	return nil
}
func (r *Repository) GrantSeal(ctx context.Context, id, userID, by string) error {
	_, err := r.Q.Exec(ctx, `INSERT INTO seal_grants(asset_id,user_id,granted_by)
 SELECT a.id,$2,$3 FROM seal_assets a WHERE a.id=$1 AND a.kind='company' AND a.retired_at IS NULL
 ON CONFLICT(asset_id,user_id) DO NOTHING`, id, userID, by)
	return err
}
func (r *Repository) RevokeSealGrant(ctx context.Context, id, userID string) error {
	_, err := r.Q.Exec(ctx, "DELETE FROM seal_grants WHERE asset_id=$1 AND user_id=$2", id, userID)
	return err
}
func (r *Repository) HasSealGrant(ctx context.Context, id, userID string) (bool, error) {
	var exists bool
	err := r.Q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM seal_grants WHERE asset_id=$1 AND user_id=$2)", id, userID).Scan(&exists)
	return exists, err
}
func (r *Repository) InsertSealMark(ctx context.Context, m domain.FileSealMark) error {
	// Lock the file while checking the recorded immutable version. A concurrent
	// save cannot silently move current version between decision and insert.
	var current int
	err := r.Q.QueryRow(ctx, "SELECT current_version_seq FROM files WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", m.FileID).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.ErrRowMissing
	}
	if err != nil {
		return err
	}
	if current != m.VersionSeq {
		return domain.ErrVersionConflict
	}
	tag, err := r.Q.Exec(ctx, `INSERT INTO file_seal_marks(id,file_id,version_seq,file_sha256,asset_id,asset_kind,asset_sha256,signer_id,page_number,x,y,width,height,angle_degrees)
 SELECT $1,$2,$3,$4,$5,a.kind,$6,$7,$8,$9,$10,$11,$12,$13
 FROM file_versions v JOIN seal_assets a ON a.id=$5
 WHERE v.file_id=$2 AND v.seq=$3 AND v.sha256=$4 AND a.sha256=$6 AND a.retired_at IS NULL`,
		m.ID, m.FileID, m.VersionSeq, m.FileSha256, m.AssetID, m.AssetSha256, m.SignerID, m.PageNumber, m.X, m.Y, m.Width, m.Height, m.AngleDegrees)
	if isUniqueViolation(err) {
		return domain.ErrNameConflict
	}
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return domain.ErrVersionConflict
	}
	return nil
}

const marksQuery = `SELECT m.id,m.file_id,m.version_seq,m.file_sha256,m.asset_id,m.asset_sha256,a.name,a.kind,m.signer_id,u.display_name,m.page_number,m.x::float8,m.y::float8,m.width::float8,m.height::float8,m.angle_degrees::float8,m.created_at
 FROM file_seal_marks m JOIN seal_assets a ON a.id=m.asset_id JOIN users u ON u.id=m.signer_id`

func scanSealMark(rows pgx.Rows) ([]domain.FileSealMark, error) {
	out := []domain.FileSealMark{}
	for rows.Next() {
		var m domain.FileSealMark
		if err := rows.Scan(&m.ID, &m.FileID, &m.VersionSeq, &m.FileSha256, &m.AssetID, &m.AssetSha256, &m.AssetName, &m.AssetKind, &m.SignerID, &m.SignerName, &m.PageNumber, &m.X, &m.Y, &m.Width, &m.Height, &m.AngleDegrees, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
func (r *Repository) ListSealMarks(ctx context.Context, fileID string, seq int) ([]domain.FileSealMark, error) {
	return r.ListSealMarksAtRevision(ctx, fileID, seq, -1)
}
func (r *Repository) GetSealMark(ctx context.Context, fileID, markID string) (domain.FileSealMark, error) {
	rows, err := r.Q.Query(ctx, marksQuery+" WHERE m.file_id=$1 AND m.id=$2", fileID, markID)
	if err != nil {
		return domain.FileSealMark{}, err
	}
	defer rows.Close()
	result, err := scanSealMark(rows)
	if err != nil {
		return domain.FileSealMark{}, err
	}
	if len(result) == 0 {
		return domain.FileSealMark{}, ports.ErrRowMissing
	}
	return result[0], nil
}

var _ ports.SealStore = (*Repository)(nil)
