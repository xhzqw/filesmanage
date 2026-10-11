package application
import("context";"filesmanage/internal/domain";"filesmanage/internal/ports")
func(r *memoryRepo)FolderLifecyclePolicy(_ context.Context,id string)(domain.LifecyclePolicy,error){
 r.mu.Lock();defer r.mu.Unlock()
 p,ok:=r.lifecycleFolderPolicies[id];if !ok{return p,ports.ErrRowMissing};return p,nil
}
func(r *memoryRepo)DepartmentLifecyclePolicy(_ context.Context,id string)(domain.LifecyclePolicy,error){
 r.mu.Lock();defer r.mu.Unlock()
 p,ok:=r.lifecycleDepartmentPolicies[id];if !ok{return p,ports.ErrRowMissing};return p,nil
}
func(r *memoryRepo)PutFolderLifecyclePolicy(_ context.Context,id string,p domain.LifecyclePolicy,_ string)error{
 r.mu.Lock();defer r.mu.Unlock()
 if r.lifecycleFolderPolicies==nil{r.lifecycleFolderPolicies=map[string]domain.LifecyclePolicy{}}
 r.lifecycleFolderPolicies[id]=p;return nil
}
func(r *memoryRepo)PutDepartmentLifecyclePolicy(_ context.Context,id string,p domain.LifecyclePolicy,_ string)error{
 r.mu.Lock();defer r.mu.Unlock()
 if r.lifecycleDepartmentPolicies==nil{r.lifecycleDepartmentPolicies=map[string]domain.LifecyclePolicy{}}
 r.lifecycleDepartmentPolicies[id]=p;return nil
}
func(r *memoryRepo)DeleteFolderLifecyclePolicy(_ context.Context,id string)error{
 r.mu.Lock();defer r.mu.Unlock();delete(r.lifecycleFolderPolicies,id);return nil
}
func(r *memoryRepo)DeleteDepartmentLifecyclePolicy(_ context.Context,id string)error{
 r.mu.Lock();defer r.mu.Unlock();delete(r.lifecycleDepartmentPolicies,id);return nil
}
