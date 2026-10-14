package postgres

import "context"

// TrashHistoryAccessible evaluates the same deleted-by / ancestor-upload
// rules as trash restoration, but starts from a stable file ID. A folder trash
// event also covers all files in its deleted descendant subtree.
func (r *Repository) TrashHistoryAccessible(ctx context.Context, fileID, userID string) (bool, error) {
	var allowed bool
	err := r.Q.QueryRow(ctx, `WITH RECURSIVE ancestors(id) AS (
    SELECT f.folder_id FROM files f WHERE f.id=$1 AND f.deleted_at IS NOT NULL
    UNION ALL
    SELECT p.parent_id FROM ancestors a JOIN folders p ON p.id=a.id
    WHERE p.parent_id IS NOT NULL
  ), candidates AS (
    SELECT DISTINCT t.id,t.deleted_by,t.old_parent_id FROM trash_entries t
    WHERE t.restored_at IS NULL AND t.purged_at IS NULL
      AND (t.file_id=$1 OR t.folder_id IN (SELECT id FROM ancestors))
  ), restore_chain(entry_id,folder_id) AS (
    SELECT c.id,c.old_parent_id FROM candidates c WHERE c.old_parent_id IS NOT NULL
    UNION ALL
    SELECT chain.entry_id,p.parent_id FROM restore_chain chain
      JOIN folders p ON p.id=chain.folder_id WHERE p.parent_id IS NOT NULL
  )
  SELECT EXISTS(
    SELECT 1 FROM candidates c WHERE c.deleted_by=$2 OR EXISTS(
      SELECT 1 FROM restore_chain chain JOIN acls g ON g.folder_id=chain.folder_id
      WHERE chain.entry_id=c.id
        AND (g.expires_at IS NULL OR g.expires_at>now())
        AND 'upload'=ANY(g.actions)
        AND ((g.subject_kind='user' AND g.subject_id=$2)
          OR (g.subject_kind='group' AND g.subject_id IN
            (SELECT group_id FROM workgroup_members WHERE user_id=$2)))
    )
  )`, fileID, userID).Scan(&allowed)
	return allowed, err
}
