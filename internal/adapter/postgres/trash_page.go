package postgres

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

func (r *Repository) PageTrashEntries(ctx context.Context, q ports.TrashQuery) ([]domain.TrashEntry, error) {
	if q.Limit < 1 || q.Limit > 101 || q.Offset < 0 || q.Offset > 100000 {
		return nil, domain.ErrInvalidInput
	}
	order := "t.deleted_at DESC,t.id DESC"
	switch q.Sort {
	case "", "recent":
	case "oldest":
		order = "t.deleted_at ASC,t.id ASC"
	case "name":
		order = "lower(t.old_name) ASC,t.id ASC"
	default:
		return nil, domain.ErrInvalidInput
	}
	var from any
	if !q.From.IsZero() {
		from = q.From
	}
	sql := `WITH RECURSIVE chains(entry_id,folder_id) AS (
 SELECT id,old_parent_id FROM trash_entries WHERE old_parent_id IS NOT NULL
 UNION ALL SELECT c.entry_id,f.parent_id FROM chains c JOIN folders f ON f.id=c.folder_id WHERE f.parent_id IS NOT NULL
 ), permitted AS (
 SELECT DISTINCT c.entry_id FROM chains c JOIN acls g ON g.folder_id=c.folder_id
 WHERE (g.expires_at IS NULL OR g.expires_at>now()) AND 'upload'=ANY(g.actions)
 AND ((g.subject_kind='user' AND g.subject_id=$1)
 OR (g.subject_kind='group' AND g.subject_id IN (SELECT group_id FROM workgroup_members WHERE user_id=$1)))
 )
 SELECT t.id,t.file_id,t.folder_id,t.old_parent_id,t.old_name,t.deleted_by,coalesce(u.display_name,''),t.deleted_at,t.restored_at,t.purged_at,t.old_parent_trail
 FROM trash_entries t LEFT JOIN users u ON u.id=t.deleted_by
 WHERE t.restored_at IS NULL AND t.purged_at IS NULL
 AND (t.deleted_by=$1 OR t.id IN (SELECT entry_id FROM permitted))
 AND ($2='' OR strpos(lower(t.old_name),lower($2))>0)
 AND ($3='' OR $3='all' OR ($3='file' AND t.file_id IS NOT NULL) OR ($3='folder' AND t.folder_id IS NOT NULL))
 AND ($4='' OR strpos(lower(coalesce(u.display_name,'')),lower($4))>0 OR strpos(lower(coalesce(u.login,'')),lower($4))>0)
 AND ($5::timestamptz IS NULL OR t.deleted_at >= $5)
 ORDER BY ` + order + ` LIMIT $6 OFFSET $7`
	rows, err := r.Q.Query(ctx, sql, q.UserID, q.Search, q.Kind, q.DeletedBy, from, q.Limit, q.Offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.TrashEntry, 0, q.Limit)
	for rows.Next() {
		var t domain.TrashEntry
		var snapshot []byte
		if err = rows.Scan(&t.ID, &t.FileID, &t.FolderID, &t.OldParentID, &t.OldName, &t.DeletedBy, &t.DeletedName, &t.DeletedAt, &t.RestoredAt, &t.PurgedAt,&snapshot); err != nil {
			return nil, err
		}
		if len(snapshot)>0 {if err=json.Unmarshal(snapshot,&t.OldParentTrail);err!=nil{return nil,err}}
		out = append(out, t)
	}
	return out, rows.Err()
}
