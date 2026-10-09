package httpx

import (
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"strconv"
)

// Organization handlers. Every route is admin-only; the application layer
// re-checks the role, handlers only shape transport.

func (h *Handler) listUsers(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if _, paged := c.GetQuery("limit"); paged || c.Query("cursor") != "" {
		limit, err := organizationLimit(c)
		if err != nil {
			c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
			return
		}
		page, err := h.S.PageUsers(c.Request.Context(), u, c.Query("cursor"), limit)
		if err != nil {
			respondError(c, err)
			return
		}
		items := make([]gin.H, 0, len(page.Items))
		for _, item := range page.Items {
			items = append(items, userPayload(item))
		}
		c.JSON(200, gin.H{"ok": true, "data": gin.H{"items": items, "nextCursor": page.NextCursor}})
		return
	}
	users, err := h.S.ListUsers(c.Request.Context(), u)
	if err != nil {
		respondError(c, err)
		return
	}
	data := make([]gin.H, 0, len(users))
	for _, item := range users {
		data = append(data, userPayload(item))
	}
	c.JSON(200, gin.H{"ok": true, "data": data})
}

func organizationLimit(c *gin.Context) (int, error) {
	value := c.DefaultQuery("limit", "100")
	limit, err := strconv.Atoi(value)
	if err != nil || limit < 1 || limit > 200 {
		return 0, domain.ErrInvalidInput
	}
	return limit, nil
}

func (h *Handler) createUser(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		Login        string
		DisplayName  string
		DepartmentID string
		IsAdmin      bool
		Password     string
	}
	if c.ShouldBindJSON(&req) != nil {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	created, err := h.S.CreateUser(c.Request.Context(), u, userDraft(req.Login, req.DisplayName, req.DepartmentID, req.IsAdmin, req.Password))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(201, gin.H{"ok": true, "data": userPayload(created)})
}

func (h *Handler) resetUserPassword(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		Password string
	}
	if c.ShouldBindJSON(&req) != nil {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	if err := h.S.ResetUserPassword(c.Request.Context(), u, c.Param("id"), req.Password); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"reset": c.Param("id")}})
}

func (h *Handler) setUserDisabled(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if err := h.S.SetUserDisabled(c.Request.Context(), u, c.Param("id"), c.Param("state") == "disable"); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"id": c.Param("id"), "disabled": c.Param("state") == "disable"}})
}

func (h *Handler) listDepartments(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	departments, err := h.S.ListDepartments(c.Request.Context(), u)
	if err != nil {
		respondError(c, err)
		return
	}
	data := make([]gin.H, 0, len(departments))
	for _, d := range departments {
		data = append(data, gin.H{"id": d.ID, "name": d.Name, "parentId": d.ParentID})
	}
	c.JSON(200, gin.H{"ok": true, "data": data})
}

func (h *Handler) createDepartment(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		Name     string
		ParentID string
	}
	if c.ShouldBindJSON(&req) != nil {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	department, err := h.S.CreateDepartment(c.Request.Context(), u, req.Name, req.ParentID)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(201, gin.H{"ok": true, "data": gin.H{"id": department.ID, "name": department.Name}})
}

func (h *Handler) listWorkgroups(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if _, paged := c.GetQuery("limit"); paged || c.Query("cursor") != "" {
		limit, err := organizationLimit(c)
		if err != nil {
			c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
			return
		}
		page, err := h.S.PageWorkgroups(c.Request.Context(), u, c.Query("cursor"), limit)
		if err != nil {
			respondError(c, err)
			return
		}
		items := make([]gin.H, 0, len(page.Items))
		for _, g := range page.Items {
			items = append(items, gin.H{"id": g.ID, "name": g.Name, "departmentId": g.DepartmentID})
		}
		c.JSON(200, gin.H{"ok": true, "data": gin.H{"items": items, "nextCursor": page.NextCursor}})
		return
	}
	groups, err := h.S.ListWorkgroups(c.Request.Context(), u)
	if err != nil {
		respondError(c, err)
		return
	}
	data := make([]gin.H, 0, len(groups))
	for _, g := range groups {
		data = append(data, gin.H{"id": g.ID, "name": g.Name, "departmentId": g.DepartmentID})
	}
	c.JSON(200, gin.H{"ok": true, "data": data})
}

func (h *Handler) createWorkgroup(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		Name         string
		DepartmentID string
	}
	if c.ShouldBindJSON(&req) != nil {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	group, err := h.S.CreateWorkgroup(c.Request.Context(), u, req.Name, req.DepartmentID)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(201, gin.H{"ok": true, "data": gin.H{"id": group.ID, "name": group.Name}})
}

func (h *Handler) workgroupMembers(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	members, err := h.S.WorkgroupMembers(c.Request.Context(), u, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	data := make([]gin.H, 0, len(members))
	for _, m := range members {
		data = append(data, userPayload(m))
	}
	c.JSON(200, gin.H{"ok": true, "data": data})
}

func (h *Handler) addWorkgroupMember(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	var req struct {
		UserID string
	}
	if c.ShouldBindJSON(&req) != nil || req.UserID == "" {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	if err := h.S.AddWorkgroupMember(c.Request.Context(), u, c.Param("id"), req.UserID); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(201, gin.H{"ok": true, "data": gin.H{"groupId": c.Param("id"), "userId": req.UserID}})
}

func (h *Handler) removeWorkgroupMember(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if err := h.S.RemoveWorkgroupMember(c.Request.Context(), u, c.Param("id"), c.Param("uid")); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"groupId": c.Param("id"), "userId": c.Param("uid"), "removed": true}})
}
