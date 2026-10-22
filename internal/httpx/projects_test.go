package httpx

import (
	"context"
	"encoding/json"
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/gin-gonic/gin"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The frontend reads reply.error.code and reply.error.message, so both must be
// present: a code-only body silently degrades to E_INTERNAL in shared/http.ts.
func TestProjectErrorEnvelopeCarriesCodeAndChineseMessage(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{domain.ErrInvalidInput, 400, "E_INVALID_INPUT"},
		{application.ErrInvalidInput, 400, "E_INVALID_INPUT"},
		{domain.ErrUnauthorized, 401, "E_AUTH"},
		{domain.ErrForbidden, 403, "E_FORBIDDEN"},
		{domain.ErrNotFound, 404, "E_NOT_FOUND"},
		{domain.ErrConflict, 409, "E_CONFLICT"},
		{errProjectUnknown, 500, "E_INTERNAL"},
	}
	for _, tc := range cases {
		c, rec := projectTestContext(http.MethodGet, "/api/projects")
		projectError(c, tc.err)
		if rec.Code != tc.status {
			t.Fatalf("%v status=%d want=%d", tc.err, rec.Code, tc.status)
		}
		var body struct {
			OK    bool `json:"ok"`
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.OK || body.Error.Code != tc.code || body.Error.Message == "" {
			t.Fatalf("bad envelope for %v: %s", tc.err, rec.Body.String())
		}
	}
}

type projectUnknownError struct{}

func (projectUnknownError) Error() string { return "boom" }

var errProjectUnknown = projectUnknownError{}

func projectTestContext(method, target string) (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(method, target, nil)
	return c, rec
}

// The declared frontend types are startDate:string|null and endDate:string|null
// (gantt computes day offsets from them), so the payload must never emit an
// RFC3339 instant or an empty string.
func TestProjectPayloadShapesMatchFrontendContract(t *testing.T) {
	start := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 5, 11, 0, 0, 0, 0, time.UTC)
	payload := projectProjectPayload(ports.Project{
		ID: 7, Name: "受控文件 V2 迁移", Icon: "◈", Description: "背景", Status: "progress",
		Priority: "high", Team: "工程部", OwnerID: "u_user", OwnerName: "普通用户", Progress: 42,
		StartDate: &start, EndDate: &end, Favorite: true, CreatedBy: "u_admin",
		CreatedAt: time.Date(2026, 10, 8, 13, 0, 0, 0, time.UTC),
		UpdatedAt: time.Date(2026, 10, 8, 13, 5, 0, 0, time.UTC),
		Comments:  []ports.ProjectComment{{ID: 1, Author: "系统管理员", AuthorID: "u_admin", Body: "开始", CreatedAt: start}},
		Todos:     []ports.ProjectTodo{{ID: 2, Body: "验收", Done: true}},
		Docs:      []ports.ProjectDoc{{DocID: "file_1", Name: "a.pdf", Kind: "pdf"}},
	})
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["startDate"] != "2026-05-01" || decoded["endDate"] != "2026-05-11" {
		t.Fatalf("dates must be YYYY-MM-DD, not instants: %v / %v", decoded["startDate"], decoded["endDate"])
	}
	if decoded["ownerName"] != "普通用户" || decoded["createdAt"].(float64) != float64(time.Date(2026, 10, 8, 13, 0, 0, 0, time.UTC).UnixMilli()) {
		t.Fatalf("owner join or millisecond timestamps missing: %s", raw)
	}
	comments := decoded["comments"].([]any)
	comment := comments[0].(map[string]any)
	if comment["who"] != "系统管理员" || comment["whoId"] != "u_admin" || comment["at"] == "" {
		t.Fatalf("comment must carry author name, id and display time: %v", comment)
	}
	if _, ok := comment["createdAt"].(float64); !ok {
		t.Fatal("comment createdAt must be a millisecond number")
	}
	todos := decoded["todos"].([]any)
	if todos[0].(map[string]any)["text"] != "验收" {
		t.Fatalf("todo text missing: %v", todos[0])
	}
	docs := decoded["docs"].([]any)
	if docs[0].(map[string]any)["docId"] != "file_1" {
		t.Fatalf("doc id missing: %v", docs[0])
	}

	// Unset dates are null and empty sub-resources are [] rather than null.
	empty, _ := json.Marshal(projectProjectPayload(ports.Project{ID: 8, Name: "无日期"}))
	var emptyDecoded map[string]any
	_ = json.Unmarshal(empty, &emptyDecoded)
	if emptyDecoded["startDate"] != nil || emptyDecoded["endDate"] != nil {
		t.Fatalf("unset dates must be null: %s", empty)
	}
	for _, key := range []string{"comments", "todos", "docs"} {
		if _, ok := emptyDecoded[key].([]any); !ok {
			t.Fatalf("%s must be an array, got %T", key, emptyDecoded[key])
		}
	}
}

// ProjectList must always carry asOf, even for an empty page: the frontend type
// is non-optional and a missing value breaks the response contract.
func TestProjectListPayloadAlwaysCarriesAsOf(t *testing.T) {
	c, rec := projectTestContext(http.MethodGet, "/api/projects")
	projectOK(c, 200, gin.H{"items": []any{}, "nextCursor": nil, "asOf": "2026-10-22T03:44:00Z"})
	var body struct {
		Data struct {
			Items      []any   `json:"items"`
			NextCursor *string `json:"nextCursor"`
			AsOf       string  `json:"asOf"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data.AsOf == "" || body.Data.Items == nil || body.Data.NextCursor != nil {
		t.Fatalf("page contract broken: %s", rec.Body.String())
	}
}

// Unknown JSON members are rejected so a client cannot smuggle archived/createdAt
// through the create payload, and trailing JSON is never silently ignored.
func TestProjectBindRejectsUnknownAndTrailingJSON(t *testing.T) {
	for _, tc := range []struct {
		body string
		ok   bool
	}{
		{`{"name":"项目甲"}`, true},
		{`{"name":"项目甲","actorId":"u_admin"}`, false},
		{`{"name":"项目甲"} {"name":"项目乙"}`, false},
		{`{"name":"项目甲"}`, true},
	} {
		c, rec := projectTestContext(http.MethodPost, "/api/projects")
		c.Request = httptest.NewRequest(http.MethodPost, "/api/projects", strings.NewReader(tc.body))
		var in application.ProjectWriteInput
		got := projectBind(c, &in, 131072)
		if got != tc.ok {
			t.Fatalf("bind %q => %v want %v (%s)", tc.body, got, tc.ok, rec.Body.String())
		}
		if !tc.ok && !strings.Contains(rec.Body.String(), "E_INVALID_INPUT") {
			t.Fatalf("rejection must be E_INVALID_INPUT: %s", rec.Body.String())
		}
	}
}

type projectTestTx struct {
	ports.Repository
	user   domain.User
	items  []ports.Project
	view   []byte
	todos  map[int64]bool
	lastID int64
}

func (t *projectTestTx) UserBySessionHash(context.Context, string) (domain.Authenticated, error) {
	return domain.Authenticated{User: t.user, ExpiresAt: time.Now().Add(time.Hour)}, nil
}

func (t *projectTestTx) SetSessionMetadata(context.Context, string, string, string, string) error {
	return nil
}
func (*projectTestTx) TouchSession(context.Context, string) error { return nil }

func (t *projectTestTx) ProjectList(context.Context) ([]ports.Project, error) {
	return t.items, nil
}
func (t *projectTestTx) ProjectByID(_ context.Context, id int64, _ bool) (ports.Project, error) {
	for _, p := range t.items {
		if p.ID == id {
			return p, nil
		}
	}
	return ports.Project{}, domain.ErrNotFound
}
func (t *projectTestTx) ProjectCreate(_ context.Context, p ports.Project) (ports.Project, error) {
	t.lastID++
	p.ID = t.lastID
	t.items = append(t.items, p)
	return p, nil
}
func (t *projectTestTx) ProjectUpdate(_ context.Context, p ports.Project) (ports.Project, error) {
	for i := range t.items {
		if t.items[i].ID == p.ID {
			t.items[i] = p
			return p, nil
		}
	}
	return ports.Project{}, domain.ErrNotFound
}
func (t *projectTestTx) ProjectSetArchived(_ context.Context, id int64, archived bool) error {
	for i := range t.items {
		if t.items[i].ID == id {
			t.items[i].Archived = archived
			return nil
		}
	}
	return domain.ErrNotFound
}
func (*projectTestTx) ProjectTouch(context.Context, int64) error { return nil }
func (t *projectTestTx) ProjectAddComment(_ context.Context, c ports.ProjectComment) (ports.ProjectComment, error) {
	return c, nil
}
func (t *projectTestTx) ProjectAddTodo(_ context.Context, todo ports.ProjectTodo) (ports.ProjectTodo, error) {
	todo.ID = 1
	t.todos = map[int64]bool{todo.ID: false}
	return todo, nil
}
func (t *projectTestTx) ProjectSetTodoDone(_ context.Context, _, todoID int64, done bool) (bool, error) {
	if _, ok := t.todos[todoID]; !ok {
		return false, nil
	}
	t.todos[todoID] = done
	return true, nil
}
func (t *projectTestTx) ProjectDeleteTodo(_ context.Context, _, todoID int64) (bool, error) {
	if _, ok := t.todos[todoID]; !ok {
		return false, nil
	}
	delete(t.todos, todoID)
	return true, nil
}
func (*projectTestTx) ProjectUpsertDocs(_ context.Context, _ int64, docs []ports.ProjectDoc) (int, error) {
	return len(docs), nil
}
func (*projectTestTx) ProjectDeleteDoc(context.Context, int64, string) (bool, error) {
	return true, nil
}
func (t *projectTestTx) ProjectViewState(context.Context, string, string) ([]byte, error) {
	if t.view == nil {
		return nil, domain.ErrNotFound
	}
	return t.view, nil
}
func (t *projectTestTx) ProjectPutViewState(_ context.Context, _, _ string, config []byte) error {
	t.view = config
	return nil
}
func (*projectTestTx) UserExists(context.Context, string) (bool, error) { return true, nil }
func (*projectTestTx) RecordAudit(context.Context, domain.AuditEvent) error {
	return nil
}
func (*projectTestTx) Commit(context.Context) error   { return nil }
func (*projectTestTx) Rollback(context.Context) error { return nil }

type projectTestUOW struct{ tx *projectTestTx }

func (u projectTestUOW) Begin(context.Context) (ports.Tx, error) { return u.tx, nil }

// End-to-end transport check without a database: routes exist, the session gate
// applies, and the success envelopes match BACKEND-API.md.
func TestProjectRoutesAuthAndSuccessEnvelopes(t *testing.T) {
	t.Setenv("FILESMANAGE_LAN_ALLOW_CIDRS", "127.0.0.1/32")
	tx := &projectTestTx{user: domain.User{ID: "u_admin", DisplayName: "系统管理员", IsAdmin: true}}
	srv := New(application.New(projectTestUOW{tx}, nil), false, t.TempDir())
	token := strings.Repeat("A", 43)

	call := func(method, path, body string, withCookie bool) *httptest.ResponseRecorder {
		var reader *strings.Reader
		if body == "" {
			reader = strings.NewReader("")
		} else {
			reader = strings.NewReader(body)
		}
		req := httptest.NewRequest(method, path, reader)
		req.RemoteAddr = "127.0.0.1:10240"
		if withCookie {
			req.AddCookie(&http.Cookie{Name: "fm_session", Value: token})
		}
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		return rec
	}

	if rec := call(http.MethodGet, "/api/projects", "", false); rec.Code != 401 || !strings.Contains(rec.Body.String(), "E_AUTH") {
		t.Fatalf("anonymous list must be 401 E_AUTH: %d %s", rec.Code, rec.Body.String())
	}
	// view-state must not be swallowed by /projects/:id.
	rec := call(http.MethodGet, "/api/projects/view-state", "", true)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"config":null`) {
		t.Fatalf("unsaved view-state must be config:null: %d %s", rec.Code, rec.Body.String())
	}
	if rec = call(http.MethodPut, "/api/projects/view-state", `{"view":"gantt","scope":"mine"}`, true); rec.Code != 200 {
		t.Fatalf("view-state write failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec = call(http.MethodGet, "/api/projects/view-state", "", true); !strings.Contains(rec.Body.String(), `"gantt"`) {
		t.Fatalf("view-state did not round-trip: %s", rec.Body.String())
	}

	rec = call(http.MethodPost, "/api/projects", `{"name":"受控文件 V2 迁移","icon":"◈","status":"progress","priority":"high","team":"工程部","ownerId":"u_user","progress":30}`, true)
	if rec.Code != 201 || !strings.Contains(rec.Body.String(), `"ownerName"`) {
		t.Fatalf("create envelope broken: %d %s", rec.Code, rec.Body.String())
	}
	rec = call(http.MethodGet, "/api/projects", "", true)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"asOf"`) || !strings.Contains(rec.Body.String(), `"nextCursor":null`) {
		t.Fatalf("list envelope broken: %d %s", rec.Code, rec.Body.String())
	}
	if rec = call(http.MethodGet, "/api/projects/1", "", true); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"project"`) {
		t.Fatalf("detail envelope broken: %d %s", rec.Code, rec.Body.String())
	}
	if rec = call(http.MethodGet, "/api/projects/999", "", true); rec.Code != 404 || !strings.Contains(rec.Body.String(), "E_NOT_FOUND") {
		t.Fatalf("missing project must be 404 E_NOT_FOUND: %d %s", rec.Code, rec.Body.String())
	}
	if rec = call(http.MethodGet, "/api/projects/not-a-number", "", true); rec.Code != 400 || !strings.Contains(rec.Body.String(), "E_INVALID_INPUT") {
		t.Fatalf("bad id must be 400 E_INVALID_INPUT: %d %s", rec.Code, rec.Body.String())
	}
	if rec = call(http.MethodPatch, "/api/projects/1", `{"favorite":true}`, true); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"favorite":true`) || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("favorite patch broken: %d %s", rec.Code, rec.Body.String())
	}
	if rec = call(http.MethodPatch, "/api/projects/1", `{"name":"   "}`, true); rec.Code != 400 || !strings.Contains(rec.Body.String(), "E_INVALID_INPUT") {
		t.Fatalf("blank name must be 400: %d %s", rec.Code, rec.Body.String())
	}
	if rec = call(http.MethodPost, "/api/projects/1/comments", `{"text":"第一条"}`, true); rec.Code != 201 || !strings.Contains(rec.Body.String(), `"comment"`) {
		t.Fatalf("comment envelope broken: %d %s", rec.Code, rec.Body.String())
	}
	if rec = call(http.MethodPost, "/api/projects/1/todos", `{"text":"验收"}`, true); rec.Code != 201 || !strings.Contains(rec.Body.String(), `"todo"`) {
		t.Fatalf("todo envelope broken: %d %s", rec.Code, rec.Body.String())
	}
	if rec = call(http.MethodPatch, "/api/projects/1/todos/1", `{"done":true}`, true); rec.Code != 200 {
		t.Fatalf("todo patch broken: %d %s", rec.Code, rec.Body.String())
	}
	if rec = call(http.MethodPatch, "/api/projects/1/todos/9", `{"done":true}`, true); rec.Code != 404 {
		t.Fatalf("unknown todo must be 404: %d %s", rec.Code, rec.Body.String())
	}
	if rec = call(http.MethodDelete, "/api/projects/1/todos/1", "", true); rec.Code != 200 {
		t.Fatalf("todo delete broken: %d %s", rec.Code, rec.Body.String())
	}
	// The batch route must not be captured by /projects/:id/docs/:docId.
	rec = call(http.MethodPost, "/api/projects/1/docs/batch", `{"docs":[{"docId":"file_1","name":"a.pdf","kind":"pdf"},{"docId":"file_2","name":"b.fig","kind":"figma"}]}`, true)
	if rec.Code != 201 || !strings.Contains(rec.Body.String(), `"added":2`) {
		t.Fatalf("batch link broken: %d %s", rec.Code, rec.Body.String())
	}
	if rec = call(http.MethodPost, "/api/projects/1/docs", `{"docId":"file_3","name":"c.docx","kind":"file"}`, true); rec.Code != 201 {
		t.Fatalf("single link broken: %d %s", rec.Code, rec.Body.String())
	}
	if rec = call(http.MethodPost, "/api/projects/1/docs", `{"docId":"file_3","name":"c.docx","kind":"zip"}`, true); rec.Code != 400 {
		t.Fatalf("unknown doc kind must be 400: %d %s", rec.Code, rec.Body.String())
	}
	if rec = call(http.MethodDelete, "/api/projects/1/docs/file_1", "", true); rec.Code != 200 {
		t.Fatalf("unlink broken: %d %s", rec.Code, rec.Body.String())
	}
	if rec = call(http.MethodDelete, "/api/projects/1", "", true); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"archived":true`) || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("delete envelope broken: %d %s", rec.Code, rec.Body.String())
	}
}

// Non-admins may read but never write, matching SPEC-project-db §3.4.
func TestProjectRoutesForbidMemberWrites(t *testing.T) {
	t.Setenv("FILESMANAGE_LAN_ALLOW_CIDRS", "127.0.0.1/32")
	tx := &projectTestTx{user: domain.User{ID: "u_user", DisplayName: "普通用户"}}
	srv := New(application.New(projectTestUOW{tx}, nil), false, t.TempDir())
	token := strings.Repeat("B", 43)

	send := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:10240"
		req.AddCookie(&http.Cookie{Name: "fm_session", Value: token})
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		return rec
	}
	if rec := send(http.MethodGet, "/api/projects", ""); rec.Code != 200 {
		t.Fatalf("member read must succeed: %d %s", rec.Code, rec.Body.String())
	}
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodPost, "/api/projects", `{"name":"成员创建"}`},
		{http.MethodPatch, "/api/projects/1", `{"status":"done"}`},
		{http.MethodDelete, "/api/projects/1", ""},
		{http.MethodPost, "/api/projects/1/comments", `{"text":"x"}`},
		{http.MethodPost, "/api/projects/1/docs/batch", `{"docs":[]}`},
	} {
		rec := send(tc.method, tc.path, tc.body)
		if rec.Code != 403 || !strings.Contains(rec.Body.String(), "E_FORBIDDEN") {
			t.Fatalf("%s %s must be 403 E_FORBIDDEN: %d %s", tc.method, tc.path, rec.Code, rec.Body.String())
		}
	}
}
