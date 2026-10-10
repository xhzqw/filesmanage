package postgres

import "context"

// TrashEntryRestorable mirrors the list visibility policy for one opaque ID.
// Known IDs cannot be used to restore records belonging to unrelated users.
func (r *Repository) TrashEntryRestorable(ctx context.Context,entryID,userID string)(bool,error){
	var allowed bool
	err:=r.Q.QueryRow(ctx,`WITH RECURSIVE chain(folder_id) AS (
	 SELECT old_parent_id FROM trash_entries WHERE id=$1 AND old_parent_id IS NOT NULL
	 UNION ALL SELECT f.parent_id FROM chain c JOIN folders f ON f.id=c.folder_id WHERE f.parent_id IS NOT NULL
	)
	SELECT EXISTS(SELECT 1 FROM trash_entries t WHERE t.id=$1
	 AND t.restored_at IS NULL AND t.purged_at IS NULL
	 AND (t.deleted_by=$2 OR EXISTS (
	 SELECT 1 FROM chain c JOIN acls g ON g.folder_id=c.folder_id
	 WHERE (g.expires_at IS NULL OR g.expires_at>now()) AND 'upload'=ANY(g.actions)
	 AND ((g.subject_kind='user' AND g.subject_id=$2)
	 OR (g.subject_kind='group' AND g.subject_id IN (SELECT group_id FROM workgroup_members WHERE user_id=$2)))
	 )))`,entryID,userID).Scan(&allowed)
	return allowed,err
}
