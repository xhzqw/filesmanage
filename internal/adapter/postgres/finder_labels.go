package postgres

import (
	"context"
	"filesmanage/internal/domain"
)

// Stable default IDs allow a no-op seed on every first read, including after renaming.
func (r *Repository) SeedFinderLabels(ctx context.Context, user string) error {
	_, err := r.Q.Exec(ctx, `INSERT INTO finder_labels(id,user_id,name,color,sort_order,is_default) VALUES
 ('label_'||md5($1||':red'),$1,'红色','red',0,true),
 ('label_'||md5($1||':orange'),$1,'橙色','orange',1,true),
 ('label_'||md5($1||':yellow'),$1,'黄色','yellow',2,true),
 ('label_'||md5($1||':green'),$1,'绿色','green',3,true),
 ('label_'||md5($1||':blue'),$1,'蓝色','blue',4,true),
 ('label_'||md5($1||':purple'),$1,'紫色','purple',5,true),
 ('label_'||md5($1||':gray'),$1,'灰色','gray',6,true)
 ON CONFLICT DO NOTHING`, user)
	return err
}

func (r *Repository) ListFinderLabels(ctx context.Context, user string) ([]domain.FinderLabel, error) {
	rows, err := r.Q.Query(ctx, `SELECT id,name,color,sort_order,is_default FROM finder_labels
 WHERE user_id=$1 ORDER BY sort_order,created_at,id`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []domain.FinderLabel{}
	for rows.Next() {
		var l domain.FinderLabel
		if err = rows.Scan(&l.ID, &l.Name, &l.Color, &l.SortOrder, &l.IsDefault); err != nil {
			return nil, err
		}
		result = append(result, l)
	}
	return result, rows.Err()
}
func (r *Repository) InsertFinderLabel(ctx context.Context, l domain.FinderLabel) error {
	_, err := r.Q.Exec(ctx, `INSERT INTO finder_labels(id,user_id,name,color,sort_order)
 VALUES($1,$2,$3,$4,100)`, l.ID, l.UserID, l.Name, l.Color)
	if isUniqueViolation(err) {
		return domain.ErrConflict
	}
	return err
}
func (r *Repository) UpdateFinderLabel(ctx context.Context, l domain.FinderLabel) (bool, error) {
	result, err := r.Q.Exec(ctx, `UPDATE finder_labels SET name=$3,color=$4
 WHERE user_id=$1 AND id=$2`, l.UserID, l.ID, l.Name, l.Color)
	if isUniqueViolation(err) {
		return false, domain.ErrConflict
	}
	if err != nil {
		return false, err
	}
	return result.RowsAffected() != 0, nil
}
func (r *Repository) DeleteFinderLabel(ctx context.Context, user, id string) (bool, error) {
	result, err := r.Q.Exec(ctx, `DELETE FROM finder_labels WHERE user_id=$1 AND id=$2 AND NOT is_default`, user, id)
	if err != nil {
		return false, err
	}
	return result.RowsAffected() != 0, nil
}
func (r *Repository) FinderLabelFileIDs(ctx context.Context, user, id string) ([]string, error) {
	rows, err := r.Q.Query(ctx, `SELECT f.file_id FROM finder_file_labels f
 JOIN finder_labels l ON l.id=f.label_id WHERE l.id=$1 AND l.user_id=$2
 ORDER BY f.file_id LIMIT 2000`, id, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
func (r *Repository) FinderFileLabelIDs(ctx context.Context, user, fileID string) ([]string, error) {
	rows, err := r.Q.Query(ctx, `SELECT l.id FROM finder_labels l JOIN finder_file_labels f ON f.label_id=l.id
 WHERE l.user_id=$1 AND f.file_id=$2 ORDER BY l.sort_order`, user, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
func (r *Repository) SetFinderFileLabel(ctx context.Context, labelID, fileID string, add bool) error {
	if add {
		_, err := r.Q.Exec(ctx, `INSERT INTO finder_file_labels(label_id,file_id) VALUES($1,$2)
   ON CONFLICT DO NOTHING`, labelID, fileID)
		return err
	}
	_, err := r.Q.Exec(ctx, `DELETE FROM finder_file_labels WHERE label_id=$1 AND file_id=$2`, labelID, fileID)
	return err
}
