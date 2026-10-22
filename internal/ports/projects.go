package ports

import (
	"context"
	"time"
)

// Project is one row of the workbench "项目" database. Sub-resources are loaded
// with the project so list and detail views share one shape.
type Project struct {
	ID          int64
	Name        string
	Icon        string
	Description string
	Status      string
	Priority    string
	Team        string
	OwnerID     string
	OwnerName   string
	Progress    int
	StartDate   *time.Time
	EndDate     *time.Time
	Archived    bool
	Favorite    bool
	CreatedBy   string
	CreatedAt   time.Time
	UpdatedAt   time.Time
	Comments    []ProjectComment
	Todos       []ProjectTodo
	Docs        []ProjectDoc
}

type ProjectComment struct {
	ID        int64
	ProjectID int64
	AuthorID  string
	Author    string
	Body      string
	CreatedAt time.Time
}

type ProjectTodo struct {
	ID        int64
	ProjectID int64
	Body      string
	Done      bool
}

// ProjectDoc links a project to a controlled document. DocID is a files.id;
// Name is the fallback label used when that file is no longer visible.
type ProjectDoc struct {
	DocID string
	Name  string
	Kind  string
}

type ProjectStore interface {
	// ProjectList returns every live (not archived) project, newest edit first.
	ProjectList(context.Context) ([]Project, error)
	ProjectByID(context.Context, int64, bool) (Project, error)
	ProjectCreate(context.Context, Project) (Project, error)
	// ProjectUpdate persists the whole record for one project. expectedRevision
	// is unused by the schema (no revision column); it exists so a future CAS
	// can be added without changing the service signature.
	ProjectUpdate(context.Context, Project) (Project, error)
	ProjectSetArchived(context.Context, int64, bool) error
	// ProjectTouch bumps updated_at so list ordering reflects sub-resource
	// activity (a new comment is an edit of the project).
	ProjectTouch(context.Context, int64) error

	ProjectAddComment(context.Context, ProjectComment) (ProjectComment, error)
	ProjectAddTodo(context.Context, ProjectTodo) (ProjectTodo, error)
	ProjectSetTodoDone(context.Context, int64, int64, bool) (bool, error)
	ProjectDeleteTodo(context.Context, int64, int64) (bool, error)
	// ProjectUpsertDocs inserts the given links, skipping ids already linked.
	// The caller runs it inside one transaction so a batch is all-or-nothing.
	ProjectUpsertDocs(context.Context, int64, []ProjectDoc) (int, error)
	ProjectDeleteDoc(context.Context, int64, string) (bool, error)

	ProjectViewState(context.Context, string, string) ([]byte, error)
	ProjectPutViewState(context.Context, string, string, []byte) error
}
