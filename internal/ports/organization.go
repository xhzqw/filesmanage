package ports

import (
	"context"
	"filesmanage/internal/domain"
)

// Organization management is the administrative boundary for identity data.
// All methods run inside the caller's transaction like every other store.

type OrganizationStore interface {
	ListUsers(context.Context) ([]domain.User, error)
	PageUsers(context.Context, string, int) ([]domain.User, error)
	UserByID(context.Context, string) (domain.User, error)
	CreateUser(context.Context, domain.User, string) error
	SetUserPassword(context.Context, string, string) error
	SetUserDepartment(context.Context, string, *string) error
	SetUserDisabled(context.Context, string, bool) error

	ListDepartments(context.Context) ([]domain.Department, error)
	CreateDepartment(context.Context, domain.Department) error
	RenameDepartment(context.Context, string, string) error

	ListWorkgroups(context.Context) ([]domain.Workgroup, error)
	PageWorkgroups(context.Context, string, int) ([]domain.Workgroup, error)
	WorkgroupByID(context.Context, string) (domain.Workgroup, error)
	CreateWorkgroup(context.Context, domain.Workgroup) error
	RenameWorkgroup(context.Context, string, string) error
	WorkgroupMembers(context.Context, string) ([]domain.User, error)
	AddWorkgroupMember(context.Context, string, string) error
	RemoveWorkgroupMember(context.Context, string, string) error
}
