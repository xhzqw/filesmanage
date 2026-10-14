package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

const revisionSelect = `SELECT r.id,r.file_id,r.version_seq,r.revision_no,r.mark_ids,
 cardinality(r.mark_ids),r.action,r.actor_id,u.display_name,r.restored_from,r.created_at
 FROM file_seal_revisions r JOIN users u ON u.id=r.actor_id`

func (r *Repository) ListSealRevisions(ctx context.Context, fileID string, seq int) ([]domain.SealRevision, error) {
	rows, err := r.Q.Query(ctx, revisionSelect+` WHERE r.file_id=$1 AND r.version_seq=$2 ORDER BY r.revision_no DESC LIMIT 300`, fileID, seq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []domain.SealRevision{}
	for rows.Next() {
		var item domain.SealRevision
		if err = rows.Scan(&item.ID, &item.FileID, &item.VersionSeq, &item.Revision, &item.MarkIDs, &item.MarkCount,
			&item.Action, &item.ActorID, &item.ActorName, &item.RestoredFrom, &item.CreatedAt); err != nil {
			return nil, err
		}
		list = append(list, item)
	}
	return list, rows.Err()
}

func (r *Repository) SealRevision(ctx context.Context, fileID string, seq, revision int) (domain.SealRevision, error) {
	var rev domain.SealRevision
	if revision < 0 {
		list, err := r.ListSealRevisions(ctx, fileID, seq)
		if err != nil {
			return rev, err
		}
		if len(list) == 0 {
			return domain.SealRevision{FileID: fileID, VersionSeq: seq, Revision: 0, MarkIDs: []string{}, Action: "original"}, nil
		}
		return list[0], nil
	}
	if revision == 0 {
		return domain.SealRevision{FileID: fileID, VersionSeq: seq, Revision: 0, MarkIDs: []string{}, Action: "original"}, nil
	}
	err := r.Q.QueryRow(ctx, revisionSelect+` WHERE r.file_id=$1 AND r.version_seq=$2 AND r.revision_no=$3`, fileID, seq, revision).
		Scan(&rev.ID, &rev.FileID, &rev.VersionSeq, &rev.Revision, &rev.MarkIDs, &rev.MarkCount, &rev.Action, &rev.ActorID, &rev.ActorName, &rev.RestoredFrom, &rev.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return rev, ports.ErrRowMissing
	}
	return rev, err
}

func (r *Repository) ListSealMarksAtRevision(ctx context.Context, fileID string, seq, revision int) ([]domain.FileSealMark, error) {
	rev, err := r.SealRevision(ctx, fileID, seq, revision)
	if err != nil {
		return nil, err
	}
	if len(rev.MarkIDs) == 0 {
		return []domain.FileSealMark{}, nil
	}
	rows, err := r.Q.Query(ctx, marksQuery+` WHERE m.file_id=$1 AND m.version_seq=$2 AND m.id=ANY($3)
 ORDER BY m.created_at,m.id LIMIT 300`, fileID, seq, rev.MarkIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSealMark(rows)
}

// AppendSealRevision serializes signing/restoration against both other
// signing actions and file updates, and validates the full snapshot.
func (r *Repository) AppendSealRevision(ctx context.Context, rev domain.SealRevision, expected int) error {
	if len(rev.MarkIDs) > 120 {
		return domain.ErrInvalidInput
	}

	var current int
	err := r.Q.QueryRow(ctx, `SELECT current_version_seq FROM files WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, rev.FileID).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.ErrRowMissing
	}
	if err != nil {
		return err
	}
	if current != rev.VersionSeq {
		return domain.ErrVersionConflict
	}
	var maxNo int
	err = r.Q.QueryRow(ctx, `SELECT COALESCE(MAX(revision_no),0) FROM file_seal_revisions WHERE file_id=$1 AND version_seq=$2`, rev.FileID, rev.VersionSeq).Scan(&maxNo)
	if err != nil {
		return err
	}
	if expected != maxNo || rev.Revision != maxNo+1 {
		return domain.ErrVersionConflict
	}
	var total, unique int
	err = r.Q.QueryRow(ctx, `SELECT count(*),count(DISTINCT asset_sha256)
 FROM file_seal_marks WHERE file_id=$1 AND version_seq=$2 AND id=ANY($3)`, rev.FileID, rev.VersionSeq, rev.MarkIDs).Scan(&total, &unique)
	if err != nil {
		return err
	}
	if total != len(rev.MarkIDs) || total != unique {
		return domain.ErrNameConflict
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO file_seal_revisions(id,file_id,version_seq,revision_no,mark_ids,action,actor_id,restored_from)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, rev.ID, rev.FileID, rev.VersionSeq, rev.Revision, rev.MarkIDs, rev.Action, rev.ActorID, rev.RestoredFrom)
	if isUniqueViolation(err) {
		return domain.ErrVersionConflict
	}
	return err
}
