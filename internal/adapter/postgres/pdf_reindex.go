package postgres

import "context"

func (r *Repository) PDFFileIDsAfter(ctx context.Context, after string, limit int) ([]string, error) {
	rows, err := r.Q.Query(ctx, `SELECT id FROM files WHERE deleted_at IS NULL AND lower(name) LIKE '%.pdf'
 AND id>$1 ORDER BY id ASC LIMIT $2`, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
