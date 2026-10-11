package ports
import("context";"filesmanage/internal/domain")

type LifecyclePolicyStore interface{
 FolderLifecyclePolicy(context.Context,string)(domain.LifecyclePolicy,error)
 DepartmentLifecyclePolicy(context.Context,string)(domain.LifecyclePolicy,error)
 PutFolderLifecyclePolicy(context.Context,string,domain.LifecyclePolicy,string)error
 PutDepartmentLifecyclePolicy(context.Context,string,domain.LifecyclePolicy,string)error
 DeleteFolderLifecyclePolicy(context.Context,string)error
 DeleteDepartmentLifecyclePolicy(context.Context,string)error
}
