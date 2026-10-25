package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

var _ ports.KnowledgeStore = (*Repository)(nil)

const knowledgeSelect = "id,parent_id,folder_id,owner_id,title,blocks,revision,updated_at"

func scanKnowledge(row rowScanner) (ports.KnowledgePage, error) {
	var p ports.KnowledgePage
	err := row.Scan(&p.ID, &p.ParentID, &p.FolderID, &p.OwnerID, &p.Title, &p.Blocks, &p.Revision, &p.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, ports.ErrRowMissing
	}
	return p, err
}
func (r *Repository) KnowledgeList(ctx context.Context, owner string) ([]ports.KnowledgePage, error) {
	rows, err := r.Q.Query(ctx, "SELECT "+knowledgeSelect+" FROM knowledge_pages WHERE (owner_id=$1 OR folder_id IS NOT NULL) AND deleted_at IS NULL ORDER BY created_at,id LIMIT 3000", owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ports.KnowledgePage, 0)
	for rows.Next() {
		p, e := scanKnowledge(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
func (r *Repository) KnowledgeByID(ctx context.Context, id string) (ports.KnowledgePage, error) {
	return scanKnowledge(r.Q.QueryRow(ctx, "SELECT "+knowledgeSelect+" FROM knowledge_pages WHERE id=$1 AND deleted_at IS NULL", id))
}
func (r *Repository) KnowledgeHistory(ctx context.Context, id string) ([]ports.KnowledgeVersion, error) {
	rows, err := r.Q.Query(ctx, `SELECT revision,title,blocks,editor_id,recorded_at FROM knowledge_page_revisions
 WHERE page_id=$1 ORDER BY revision DESC LIMIT 100`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ports.KnowledgeVersion, 0)
	for rows.Next() {
		var v ports.KnowledgeVersion
		if err := rows.Scan(&v.Revision, &v.Title, &v.Blocks, &v.EditorID, &v.RecordedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (r *Repository) KnowledgeCreate(ctx context.Context, p ports.KnowledgePage) error {
	_, err := r.Q.Exec(ctx, `INSERT INTO knowledge_pages(id,parent_id,folder_id,owner_id,title,blocks)
 VALUES($1,$2,$3,$4,$5,$6)`, p.ID, p.ParentID, p.FolderID, p.OwnerID, p.Title, []byte(p.Blocks))
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO knowledge_page_revisions(page_id,revision,title,blocks,editor_id)
 VALUES($1,1,$2,$3,$4)`, p.ID, p.Title, []byte(p.Blocks), p.OwnerID)
	return err
}
func (r *Repository) KnowledgeUpdate(ctx context.Context, p ports.KnowledgePage, base int, editor string) (bool, error) {
	var actual int
	err := r.Q.QueryRow(ctx, `SELECT revision FROM knowledge_pages
 WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, p.ID).Scan(&actual)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ports.ErrRowMissing
	}
	if err != nil {
		return false, err
	}
	if actual != base {
		return false, nil
	}
	_, err = r.Q.Exec(ctx, `UPDATE knowledge_pages SET title=$2,blocks=$3,revision=revision+1,updated_at=now()
 WHERE id=$1`, p.ID, p.Title, []byte(p.Blocks))
	if err != nil {
		return false, err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO knowledge_page_revisions(page_id,revision,title,blocks,editor_id)
 VALUES($1,$2,$3,$4,$5)`, p.ID, base+1, p.Title, []byte(p.Blocks), editor)
	return err == nil, err
}
func (r *Repository) KnowledgeDelete(ctx context.Context, id string, base int) (bool, error) {
	tag, err := r.Q.Exec(ctx, `UPDATE knowledge_pages SET deleted_at=now(),updated_at=now(),revision=revision+1
 WHERE id=$1 AND revision=$2 AND deleted_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM knowledge_pages WHERE parent_id=$1 AND deleted_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM folder_knowledge_homes WHERE page_id=$1)`, id, base)
	return tag.RowsAffected() == 1, err
}
func (r *Repository) KnowledgeHome(ctx context.Context, folder string) (string, error) {
	var id string
	err := r.Q.QueryRow(ctx, `SELECT p.id FROM folder_knowledge_homes h
 JOIN knowledge_pages p ON p.id=h.page_id AND p.deleted_at IS NULL
 WHERE h.folder_id=$1`, folder).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return id, err
}
func (r *Repository) KnowledgeLinkHome(ctx context.Context, folder, page, actor string) error {
	tag, err := r.Q.Exec(ctx, `INSERT INTO folder_knowledge_homes(folder_id,page_id,linked_by)
 SELECT $1,p.id,$3 FROM knowledge_pages p JOIN folders f ON f.id=$1 AND f.deleted_at IS NULL
 WHERE p.id=$2 AND p.folder_id=$1 AND p.deleted_at IS NULL
 ON CONFLICT(folder_id) DO UPDATE SET page_id=EXCLUDED.page_id,linked_by=EXCLUDED.linked_by,linked_at=now()`,
		folder, page, actor)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ports.ErrRowMissing
	}
	return nil
}
func (r *Repository) KnowledgeUnlinkHome(ctx context.Context, folder string) error {
	_, err := r.Q.Exec(ctx, `DELETE FROM folder_knowledge_homes WHERE folder_id=$1`, folder)
	return err
}
func (r *Repository) KnowledgeFiles(ctx context.Context, id string) ([]ports.KnowledgeFileReference, error) {
	rows, err := r.Q.Query(ctx, `SELECT f.id,f.name,f.folder_id FROM knowledge_file_refs k
 JOIN files f ON f.id=k.file_id AND f.deleted_at IS NULL WHERE k.page_id=$1
 ORDER BY k.linked_at,f.id LIMIT 300`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ports.KnowledgeFileReference, 0)
	for rows.Next() {
		var v ports.KnowledgeFileReference
		if e := rows.Scan(&v.FileID, &v.FileName, &v.FolderID); e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (r *Repository) KnowledgeLinkFile(ctx context.Context, page, file, actor string) error {
	tag, err := r.Q.Exec(ctx, `INSERT INTO knowledge_file_refs(page_id,file_id,linked_by)
 SELECT p.id,f.id,$3 FROM knowledge_pages p,files f
 WHERE p.id=$1 AND p.deleted_at IS NULL AND f.id=$2 AND f.deleted_at IS NULL
 ON CONFLICT(page_id,file_id) DO NOTHING`, page, file, actor)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		var exists bool
		e := r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM knowledge_file_refs WHERE page_id=$1 AND file_id=$2)`, page, file).Scan(&exists)
		if e != nil {
			return e
		}
		if !exists {
			return ports.ErrRowMissing
		}
	}
	return nil
}
func (r *Repository) KnowledgeUnlinkFile(ctx context.Context, page, file string) error {
	_, err := r.Q.Exec(ctx, `DELETE FROM knowledge_file_refs WHERE page_id=$1 AND file_id=$2`, page, file)
	return err
}
func (r *Repository) KnowledgeFileBacklinks(ctx context.Context, file string) ([]ports.KnowledgeBacklink, error) {
	rows, err := r.Q.Query(ctx, `SELECT p.id,p.title,p.folder_id,p.owner_id FROM knowledge_file_refs k
 JOIN knowledge_pages p ON p.id=k.page_id AND p.deleted_at IS NULL
 WHERE k.file_id=$1 ORDER BY p.updated_at DESC,p.id LIMIT 300`, file)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ports.KnowledgeBacklink, 0)
	for rows.Next() {
		var p ports.KnowledgeBacklink
		if e := rows.Scan(&p.PageID, &p.Title, &p.FolderID, &p.OwnerID); e != nil {
			return nil, e
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
func (r *Repository) KnowledgePageLinks(ctx context.Context, id string) ([]ports.KnowledgePageLink, error) {
	rows, err := r.Q.Query(ctx, `SELECT p.id,p.title,p.folder_id,p.owner_id,'outgoing' FROM knowledge_page_links l
 JOIN knowledge_pages p ON p.id=l.target_page_id AND p.deleted_at IS NULL WHERE l.source_page_id=$1
 UNION ALL SELECT p.id,p.title,p.folder_id,p.owner_id,'incoming' FROM knowledge_page_links l
 JOIN knowledge_pages p ON p.id=l.source_page_id AND p.deleted_at IS NULL WHERE l.target_page_id=$1
 ORDER BY 5,2 LIMIT 300`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ports.KnowledgePageLink, 0)
	for rows.Next() {
		var x ports.KnowledgePageLink
		if e := rows.Scan(&x.PageID, &x.Title, &x.FolderID, &x.OwnerID, &x.Direction); e != nil {
			return nil, e
		}
		out = append(out, x)
	}
	return out, rows.Err()
}
func (r *Repository) KnowledgeLinkPage(ctx context.Context, source, target, actor string) error {
	tag, err := r.Q.Exec(ctx, `INSERT INTO knowledge_page_links(source_page_id,target_page_id,linked_by)
 SELECT s.id,t.id,$3 FROM knowledge_pages s,knowledge_pages t WHERE s.id=$1 AND s.deleted_at IS NULL
 AND t.id=$2 AND t.deleted_at IS NULL AND s.id<>t.id
 ON CONFLICT(source_page_id,target_page_id) DO NOTHING`, source, target, actor)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		var exists bool
		e := r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM knowledge_page_links WHERE source_page_id=$1 AND target_page_id=$2)`, source, target).Scan(&exists)
		if e != nil {
			return e
		}
		if !exists {
			return ports.ErrRowMissing
		}
	}
	return nil
}
func (r *Repository) KnowledgeUnlinkPage(ctx context.Context, source, target string) error {
	_, err := r.Q.Exec(ctx, `DELETE FROM knowledge_page_links WHERE source_page_id=$1 AND target_page_id=$2`, source, target)
	return err
}
