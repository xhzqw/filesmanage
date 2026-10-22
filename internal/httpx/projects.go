package httpx

import (
	"encoding/json"
	"errors"
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/gin-gonic/gin"
	"io"
	"net/http"
	"strconv"
)

// Project database transport. The frontend contract (BACKEND-API.md) requires
// the nested error envelope {ok:false,error:{code,message}}, so these handlers
// answer with their own mapping instead of respondError's code-only payloads.

func projectBind(c *gin.Context, v any, limit int64) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
	d := json.NewDecoder(c.Request.Body)
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		projectError(c, domain.ErrInvalidInput)
		return false
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		projectError(c, domain.ErrInvalidInput)
		return false
	}
	return true
}

func projectOK(c *gin.Context, status int, value any) {
	c.Header("Cache-Control", "no-store")
	c.JSON(status, gin.H{"ok": true, "data": value})
}

// projectError keeps every failure inside the documented code set and always
// attaches the user-facing Chinese message the drawer/toast displays.
func projectError(c *gin.Context, err error) {
	code, status, message := "E_INTERNAL", 500, "项目服务暂时不可用，请稍后重试"
	switch {
	case err == nil:
		return
	case errors.Is(err, application.ErrUnauthorized), errors.Is(err, domain.ErrUnauthorized):
		code, status, message = "E_AUTH", 401, "登录状态已失效，请重新登录"
	case errors.Is(err, domain.ErrForbidden):
		code, status, message = "E_FORBIDDEN", 403, "没有操作该项目的权限"
	case errors.Is(err, domain.ErrInvalidInput), errors.Is(err, application.ErrInvalidInput):
		code, status, message = "E_INVALID_INPUT", 400, "参数校验失败：请检查项目名称、日期范围与进度"
	case errors.Is(err, domain.ErrNotFound):
		code, status, message = "E_NOT_FOUND", 404, "项目或子资源不存在"
	case errors.Is(err, domain.ErrConflict):
		code, status, message = "E_CONFLICT", 409, "项目已被其他人修改，请刷新后重试"
	}
	c.JSON(status, gin.H{"ok": false, "error": gin.H{"code": code, "message": message}})
}

// projectID parses the numeric path id. A malformed id is a client error, while
// a well-formed id that names no row surfaces as E_NOT_FOUND from the service.
func projectID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		projectError(c, domain.ErrInvalidInput)
		return 0, false
	}
	return id, true
}

func projectTodoID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("todoId"), 10, 64)
	if err != nil || id < 1 {
		projectError(c, domain.ErrInvalidInput)
		return 0, false
	}
	return id, true
}

func projectCommentPayload(c ports.ProjectComment) gin.H {
	return gin.H{
		"id": c.ID, "who": c.Author, "whoId": c.AuthorID, "text": c.Body,
		"at": c.CreatedAt.Local().Format("2006-01-02 15:04"), "createdAt": c.CreatedAt.UnixMilli(),
	}
}

func projectProjectPayload(p ports.Project) gin.H {
	comments := make([]gin.H, 0, len(p.Comments))
	for _, c := range p.Comments {
		comments = append(comments, projectCommentPayload(c))
	}
	todos := make([]gin.H, 0, len(p.Todos))
	for _, t := range p.Todos {
		todos = append(todos, gin.H{"id": t.ID, "text": t.Body, "done": t.Done})
	}
	docs := make([]gin.H, 0, len(p.Docs))
	for _, d := range p.Docs {
		docs = append(docs, gin.H{"docId": d.DocID, "name": d.Name, "kind": d.Kind})
	}
	// StartDate/EndDate are declared as string|null on the frontend; a time.Time
	// would arrive as an RFC3339 instant and break the date-only contract.
	var start, end any
	if p.StartDate != nil {
		start = p.StartDate.Format("2006-01-02")
	}
	if p.EndDate != nil {
		end = p.EndDate.Format("2006-01-02")
	}
	return gin.H{
		"id": p.ID, "name": p.Name, "icon": p.Icon, "description": p.Description,
		"status": p.Status, "priority": p.Priority, "team": p.Team,
		"ownerId": p.OwnerID, "ownerName": p.OwnerName, "progress": p.Progress,
		"startDate": start, "endDate": end,
		"archived": p.Archived, "favorite": p.Favorite,
		"comments": comments, "todos": todos, "docs": docs,
		"createdBy": p.CreatedBy,
		"createdAt": p.CreatedAt.UnixMilli(), "updatedAt": p.UpdatedAt.UnixMilli(),
	}
}

func (h *Handler) projectList(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	page, err := h.S.ProjectList(c.Request.Context(), actor)
	if err != nil {
		projectError(c, err)
		return
	}
	items := make([]gin.H, 0, len(page.Items))
	for _, p := range page.Items {
		items = append(items, projectProjectPayload(p))
	}
	projectOK(c, 200, gin.H{"items": items, "nextCursor": page.NextCursor, "asOf": page.AsOf})
}

func (h *Handler) projectGet(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	id, ok := projectID(c)
	if !ok {
		return
	}
	p, err := h.S.ProjectGet(c.Request.Context(), actor, id)
	if err != nil {
		projectError(c, err)
		return
	}
	projectOK(c, 200, gin.H{"project": projectProjectPayload(p)})
}

func (h *Handler) projectCreate(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	var in application.ProjectWriteInput
	if !projectBind(c, &in, 131072) {
		return
	}
	p, err := h.S.ProjectCreate(c.Request.Context(), actor, in)
	if err != nil {
		projectError(c, err)
		return
	}
	projectOK(c, 201, gin.H{"project": projectProjectPayload(p)})
}

func (h *Handler) projectUpdate(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	id, ok := projectID(c)
	if !ok {
		return
	}
	var patch application.ProjectPatch
	if !projectBind(c, &patch, 131072) {
		return
	}
	p, err := h.S.ProjectUpdate(c.Request.Context(), actor, id, patch)
	if err != nil {
		projectError(c, err)
		return
	}
	projectOK(c, 200, gin.H{"project": projectProjectPayload(p)})
}

func (h *Handler) projectDelete(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	id, ok := projectID(c)
	if !ok {
		return
	}
	if err := h.S.ProjectDelete(c.Request.Context(), actor, id); err != nil {
		projectError(c, err)
		return
	}
	// BACKEND-API.md declares Reply<{ok:true}> for delete and notes the row is
	// archived rather than removed, so both facts are returned.
	projectOK(c, 200, gin.H{"ok": true, "archived": true})
}

func (h *Handler) projectAddComment(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	id, ok := projectID(c)
	if !ok {
		return
	}
	var in struct {
		Text string `json:"text"`
	}
	if !projectBind(c, &in, 8192) {
		return
	}
	comment, err := h.S.ProjectAddComment(c.Request.Context(), actor, id, in.Text)
	if err != nil {
		projectError(c, err)
		return
	}
	projectOK(c, 201, gin.H{"comment": projectCommentPayload(comment)})
}

func (h *Handler) projectAddTodo(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	id, ok := projectID(c)
	if !ok {
		return
	}
	var in struct {
		Text string `json:"text"`
	}
	if !projectBind(c, &in, 8192) {
		return
	}
	todo, err := h.S.ProjectAddTodo(c.Request.Context(), actor, id, in.Text)
	if err != nil {
		projectError(c, err)
		return
	}
	// The contract declares Reply<{ok:true}>; the created todo is returned too so
	// a caller can refresh without a second read.
	projectOK(c, 201, gin.H{"ok": true, "todo": gin.H{"id": todo.ID, "text": todo.Body, "done": todo.Done}})
}

func (h *Handler) projectSetTodo(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	id, ok := projectID(c)
	if !ok {
		return
	}
	todoID, ok := projectTodoID(c)
	if !ok {
		return
	}
	var in struct {
		Done bool `json:"done"`
	}
	if !projectBind(c, &in, 4096) {
		return
	}
	if err := h.S.ProjectSetTodoDone(c.Request.Context(), actor, id, todoID, in.Done); err != nil {
		projectError(c, err)
		return
	}
	projectOK(c, 200, gin.H{"ok": true})
}

func (h *Handler) projectDeleteTodo(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	id, ok := projectID(c)
	if !ok {
		return
	}
	todoID, ok := projectTodoID(c)
	if !ok {
		return
	}
	if err := h.S.ProjectDeleteTodo(c.Request.Context(), actor, id, todoID); err != nil {
		projectError(c, err)
		return
	}
	projectOK(c, 200, gin.H{"ok": true})
}

func (h *Handler) projectAddDoc(c *gin.Context) {
	h.projectAddDocBatch(c, false)
}

func (h *Handler) projectAddDocs(c *gin.Context) {
	h.projectAddDocBatch(c, true)
}

// projectAddDocBatch serves both the single-link and the picker batch endpoint:
// one insert path, one all-or-nothing transaction, `added` counts only new
// links so an idempotent re-link reports 0 without failing.
func (h *Handler) projectAddDocBatch(c *gin.Context, batch bool) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	id, ok := projectID(c)
	if !ok {
		return
	}
	var in struct {
		DocID string             `json:"docId"`
		Name  string             `json:"name"`
		Kind  string             `json:"kind"`
		Docs  []ports.ProjectDoc `json:"docs"`
	}
	limit := int64(8192)
	if batch {
		limit = 524288
	}
	if !projectBind(c, &in, limit) {
		return
	}
	docs := in.Docs
	if !batch {
		docs = []ports.ProjectDoc{{DocID: in.DocID, Name: in.Name, Kind: in.Kind}}
	}
	added, err := h.S.ProjectAddDocs(c.Request.Context(), actor, id, docs)
	if err != nil {
		projectError(c, err)
		return
	}
	projectOK(c, 201, gin.H{"ok": true, "added": added})
}

func (h *Handler) projectRemoveDoc(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	id, ok := projectID(c)
	if !ok {
		return
	}
	if err := h.S.ProjectRemoveDoc(c.Request.Context(), actor, id, c.Param("docId")); err != nil {
		projectError(c, err)
		return
	}
	projectOK(c, 200, gin.H{"ok": true})
}

func (h *Handler) projectGetView(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	raw, err := h.S.ProjectViewState(c.Request.Context(), actor)
	if err != nil {
		projectError(c, err)
		return
	}
	if len(raw) == 0 {
		projectOK(c, 200, gin.H{"config": nil})
		return
	}
	projectOK(c, 200, gin.H{"config": json.RawMessage(raw)})
}

func (h *Handler) projectPutView(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, 65536))
	if err != nil {
		projectError(c, domain.ErrInvalidInput)
		return
	}
	if err = h.S.ProjectPutViewState(c.Request.Context(), actor, json.RawMessage(raw)); err != nil {
		projectError(c, err)
		return
	}
	projectOK(c, 200, gin.H{"ok": true})
}
