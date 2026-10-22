package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
	"time"
)

// ---------- project database ----------

const projectSelect = `SELECT p.id,p.name,p.icon,p.description,p.status,p.priority,p.team,
 coalesce(p.owner_id,''),coalesce(u.display_name,''),p.progress,p.start_date,p.end_date,
 p.archived,p.favorite,p.created_by,p.created_at,p.updated_at
 FROM projects p LEFT JOIN users u ON u.id=p.owner_id`

func scanProject(row pgx.Row) (ports.Project, error) {
	var p ports.Project
	err := row.Scan(&p.ID, &p.Name, &p.Icon, &p.Description, &p.Status, &p.Priority, &p.Team,
		&p.OwnerID, &p.OwnerName, &p.Progress, &p.StartDate, &p.EndDate,
		&p.Archived, &p.Favorite, &p.CreatedBy, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, domain.ErrNotFound
	}
	if err != nil {
		return p, err
	}
	return p, nil
}

func (r *Repository) ProjectList(ctx context.Context) ([]ports.Project, error) {
	rows, err := r.Q.Query(ctx, projectSelect+` WHERE NOT p.archived ORDER BY p.updated_at DESC,p.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ports.Project, 0)
	for rows.Next() {
		p, scanErr := scanProject(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		out = append(out, p)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	// Sub-resources are loaded per project; a missing list is never a nil slice
	// because the frontend reads comments.length/todos.length directly.
	for i := range out {
		if err = r.loadProjectChildren(ctx, &out[i]); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (r *Repository) loadProjectChildren(ctx context.Context, p *ports.Project) error {
	comments, err := r.projectComments(ctx, p.ID)
	if err != nil {
		return err
	}
	todos, err := r.projectTodos(ctx, p.ID)
	if err != nil {
		return err
	}
	docs, err := r.projectDocs(ctx, p.ID)
	if err != nil {
		return err
	}
	p.Comments, p.Todos, p.Docs = comments, todos, docs
	return nil
}

func (r *Repository) projectComments(ctx context.Context, id int64) ([]ports.ProjectComment, error) {
	rows, err := r.Q.Query(ctx, `SELECT c.id,c.author_id,coalesce(u.display_name,''),c.body,c.created_at
 FROM project_comments c LEFT JOIN users u ON u.id=c.author_id
 WHERE c.project_id=$1 ORDER BY c.created_at,c.id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ports.ProjectComment, 0)
	for rows.Next() {
		var c ports.ProjectComment
		c.ProjectID = id
		if err = rows.Scan(&c.ID, &c.AuthorID, &c.Author, &c.Body, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (r *Repository) projectTodos(ctx context.Context, id int64) ([]ports.ProjectTodo, error) {
	rows, err := r.Q.Query(ctx, `SELECT id,body,done FROM project_todos WHERE project_id=$1 ORDER BY id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ports.ProjectTodo, 0)
	for rows.Next() {
		var t ports.ProjectTodo
		t.ProjectID = id
		if err = rows.Scan(&t.ID, &t.Body, &t.Done); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (r *Repository) projectDocs(ctx context.Context, id int64) ([]ports.ProjectDoc, error) {
	// The live file name wins when the document is still visible; the stored
	// name is the fallback for links whose file was purged from the trash.
	rows, err := r.Q.Query(ctx, `SELECT d.doc_id,coalesce(f.name,d.name),d.kind
 FROM project_docs d LEFT JOIN files f ON f.id=d.doc_id AND f.deleted_at IS NULL
 WHERE d.project_id=$1 ORDER BY d.created_at,d.doc_id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ports.ProjectDoc, 0)
	for rows.Next() {
		var d ports.ProjectDoc
		if err = rows.Scan(&d.DocID, &d.Name, &d.Kind); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (r *Repository) ProjectByID(ctx context.Context, id int64, lock bool) (ports.Project, error) {
	q := projectSelect + ` WHERE p.id=$1`
	if lock {
		q += ` FOR UPDATE OF p`
	}
	p, err := scanProject(r.Q.QueryRow(ctx, q, id))
	if err != nil {
		return p, err
	}
	if err = r.loadProjectChildren(ctx, &p); err != nil {
		return p, err
	}
	return p, nil
}

func (r *Repository) ProjectCreate(ctx context.Context, p ports.Project) (ports.Project, error) {
	var id int64
	err := r.Q.QueryRow(ctx, `INSERT INTO projects(name,icon,description,status,priority,team,owner_id,progress,start_date,end_date,created_by)
 VALUES($1,$2,$3,$4,$5,$6,NULLIF($7,''),$8,$9,$10,$11) RETURNING id`,
		p.Name, p.Icon, p.Description, p.Status, p.Priority, p.Team, p.OwnerID, p.Progress, p.StartDate, p.EndDate, p.CreatedBy).Scan(&id)
	if err != nil {
		return p, err
	}
	return r.ProjectByID(ctx, id, false)
}

func (r *Repository) ProjectUpdate(ctx context.Context, p ports.Project) (ports.Project, error) {
	tag, err := r.Q.Exec(ctx, `UPDATE projects SET name=$2,icon=$3,description=$4,status=$5,priority=$6,team=$7,
 owner_id=NULLIF($8,''),progress=$9,start_date=$10,end_date=$11,archived=$12,favorite=$13,updated_at=now()
 WHERE id=$1`,
		p.ID, p.Name, p.Icon, p.Description, p.Status, p.Priority, p.Team, p.OwnerID, p.Progress,
		p.StartDate, p.EndDate, p.Archived, p.Favorite)
	if err != nil {
		return p, err
	}
	if tag.RowsAffected() == 0 {
		return p, domain.ErrNotFound
	}
	return r.ProjectByID(ctx, p.ID, false)
}

func (r *Repository) ProjectSetArchived(ctx context.Context, id int64, archived bool) error {
	tag, err := r.Q.Exec(ctx, `UPDATE projects SET archived=$2,updated_at=now() WHERE id=$1`, id, archived)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrNotFound
	}
	return nil
}

func (r *Repository) ProjectTouch(ctx context.Context, id int64) error {
	_, err := r.Q.Exec(ctx, `UPDATE projects SET updated_at=now() WHERE id=$1`, id)
	return err
}

func (r *Repository) ProjectAddComment(ctx context.Context, c ports.ProjectComment) (ports.ProjectComment, error) {
	var createdAt time.Time
	err := r.Q.QueryRow(ctx, `INSERT INTO project_comments(project_id,author_id,body) VALUES($1,$2,$3)
 RETURNING id,created_at`, c.ProjectID, c.AuthorID, c.Body).Scan(&c.ID, &createdAt)
	if err != nil {
		return c, err
	}
	c.CreatedAt = createdAt
	return c, nil
}

func (r *Repository) ProjectAddTodo(ctx context.Context, t ports.ProjectTodo) (ports.ProjectTodo, error) {
	err := r.Q.QueryRow(ctx, `INSERT INTO project_todos(project_id,body) VALUES($1,$2) RETURNING id`,
		t.ProjectID, t.Body).Scan(&t.ID)
	if err != nil {
		return t, err
	}
	return t, nil
}

func (r *Repository) ProjectSetTodoDone(ctx context.Context, id, todoID int64, done bool) (bool, error) {
	tag, err := r.Q.Exec(ctx, `UPDATE project_todos SET done=$3 WHERE project_id=$1 AND id=$2`, id, todoID, done)
	return tag.RowsAffected() > 0, err
}

func (r *Repository) ProjectDeleteTodo(ctx context.Context, id, todoID int64) (bool, error) {
	tag, err := r.Q.Exec(ctx, `DELETE FROM project_todos WHERE project_id=$1 AND id=$2`, id, todoID)
	return tag.RowsAffected() > 0, err
}

// ProjectUpsertDocs links every document or none: the caller's transaction is
// the unit, and ON CONFLICT DO NOTHING makes a re-link a no-op instead of 409.
func (r *Repository) ProjectUpsertDocs(ctx context.Context, id int64, docs []ports.ProjectDoc) (int, error) {
	added := 0
	for _, doc := range docs {
		tag, err := r.Q.Exec(ctx, `INSERT INTO project_docs(project_id,doc_id,name,kind) VALUES($1,$2,$3,$4)
 ON CONFLICT(project_id,doc_id) DO NOTHING`, id, doc.DocID, doc.Name, doc.Kind)
		if err != nil {
			return 0, err
		}
		added += int(tag.RowsAffected())
	}
	return added, nil
}

func (r *Repository) ProjectDeleteDoc(ctx context.Context, id int64, docID string) (bool, error) {
	tag, err := r.Q.Exec(ctx, `DELETE FROM project_docs WHERE project_id=$1 AND doc_id=$2`, id, docID)
	return tag.RowsAffected() > 0, err
}

func (r *Repository) ProjectViewState(ctx context.Context, userID, key string) ([]byte, error) {
	var raw []byte
	err := r.Q.QueryRow(ctx, `SELECT config FROM project_view_states WHERE user_id=$1 AND view_key=$2`,
		userID, key).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, domain.ErrNotFound
	}
	return raw, err
}

func (r *Repository) ProjectPutViewState(ctx context.Context, userID, key string, config []byte) error {
	_, err := r.Q.Exec(ctx, `INSERT INTO project_view_states(user_id,view_key,config) VALUES($1,$2,$3::jsonb)
 ON CONFLICT(user_id,view_key) DO UPDATE SET config=EXCLUDED.config,updated_at=now()`, userID, key, string(config))
	return err
}

var _ = ports.ErrRowMissing
