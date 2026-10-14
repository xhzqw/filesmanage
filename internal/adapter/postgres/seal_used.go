package postgres

import (
	"context"
	"filesmanage/internal/ports"
)

func (r *Repository) UsedSealAssetIDs(ctx context.Context, fileID string) ([]string, error) {
	rows, err := r.Q.Query(ctx, `SELECT DISTINCT a.id FROM seal_assets a WHERE EXISTS(
 SELECT 1 FROM file_seal_marks m JOIN files f ON f.id=m.file_id AND f.current_version_seq=m.version_seq
 WHERE m.file_id=$1 AND (m.asset_id=a.id OR m.asset_sha256=a.sha256)
 AND m.id=ANY(COALESCE(
  (SELECT rev.mark_ids FROM file_seal_revisions rev WHERE rev.file_id=f.id AND rev.version_seq=f.current_version_seq
  ORDER BY rev.revision_no DESC LIMIT 1),'{}'::text[]))
 ) ORDER BY a.id`, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	used := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		used = append(used, id)
	}
	return used, rows.Err()
}

var _ ports.SealStore = (*Repository)(nil)
