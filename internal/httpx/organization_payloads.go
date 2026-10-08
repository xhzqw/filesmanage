package httpx

import (
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
)

// Transport payload builders for organization resources.

func userPayload(u domain.User) gin.H {
	return gin.H{
		"id": u.ID, "login": u.Login, "displayName": u.DisplayName,
		"isAdmin": u.IsAdmin, "departmentId": u.DepartmentID,
		"mustChangePassword": u.MustChangePassword,
		"disabled": u.DisabledAt != nil,
	}
}

func userDraft(login, displayName, departmentID string, isAdmin bool, password string) application.UserDraft {
	return application.UserDraft{
		Login: login, DisplayName: displayName, DepartmentID: departmentID,
		IsAdmin: isAdmin, Password: password,
	}
}
