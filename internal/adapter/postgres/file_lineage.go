package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"github.com/jackc/pgx/v5"
)

func (r *Repository) InsertFileLineage(ctx context.Context, child domain.FileLineage) error {
	_, err := r.Q.Exec(ctx, `INSERT INTO file_lineage
	 (file_id,source_file_id,source_file_name,source_version_seq,relation_type)
	 VALUES($1,$2,$3,$4,$5)`,
		child.ID, child.SourceFileID, child.SourceFileName, child.SourceVersionSeq, child.RelationType)
	return err
}

func (r *Repository) FileLineageParent(ctx context.Context, id string) (*domain.FileLineage, error) {
	var v domain.FileLineage
	err := r.Q.QueryRow(ctx, `SELECT f.id,f.name,COALESCE(f.current_version_seq,0),
	 l.created_at,l.source_file_id,l.source_file_name,l.source_version_seq,l.relation_type
	 FROM file_lineage l JOIN files f ON f.id=l.file_id WHERE l.file_id=$1`, id).
		Scan(&v.ID, &v.Name, &v.VersionSeq, &v.CreatedAt, &v.SourceFileID, &v.SourceFileName, &v.SourceVersionSeq, &v.RelationType)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &v, nil
}

func (r *Repository) FileLineageChildren(ctx context.Context, id string) ([]domain.FileLineage, error) {
	rows, err := r.Q.Query(ctx, `SELECT f.id,f.name,COALESCE(f.current_version_seq,0),
	 l.created_at,l.source_file_id,l.source_file_name,l.source_version_seq,l.relation_type
	 FROM file_lineage l JOIN files f ON f.id=l.file_id
	 WHERE l.source_file_id=$1 AND f.deleted_at IS NULL ORDER BY l.created_at DESC,f.id DESC LIMIT 100`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.FileLineage, 0)
	for rows.Next() {
		var v domain.FileLineage
		if err := rows.Scan(&v.ID, &v.Name, &v.VersionSeq, &v.CreatedAt, &v.SourceFileID, &v.SourceFileName, &v.SourceVersionSeq, &v.RelationType); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
