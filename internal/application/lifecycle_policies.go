package application
import(
 "context"
 "errors"
 "filesmanage/internal/domain"
 "filesmanage/internal/ports"
)
func validLifecyclePolicy(p domain.LifecyclePolicy)bool{
 due:=p.DueDays==0||p.DueDays==30||p.DueDays==90||p.DueDays==180||p.DueDays==365||p.DueDays==730
 keep:=p.RetentionDays==0||p.RetentionDays==30||p.RetentionDays==90||p.RetentionDays==365||p.RetentionDays==730
 return due&&keep
}
func(s *Service)effectiveLifecyclePolicy(ctx context.Context,tx ports.Repository,folderID,uploadedBy string)(domain.LifecyclePolicyView,error){
 // Nearest folder wins, including an explicitly disabled zero policy.
 visited:=map[string]bool{}
 for id:=folderID;id!=""&&!visited[id];{
  visited[id]=true
  pol,err:=tx.FolderLifecyclePolicy(ctx,id)
  if err==nil{return domain.LifecyclePolicyView{LifecyclePolicy:pol,SourceKind:"folder",SourceID:id},nil}
  if !errors.Is(err,ports.ErrRowMissing){return domain.LifecyclePolicyView{},err}
  folder,err:=tx.FolderByID(ctx,id);if err!=nil{return domain.LifecyclePolicyView{},notFoundOr(err)}
  if folder.ParentID==nil{break};id=*folder.ParentID
 }
 // Fallback: document uploader's current department, including its ancestor policy.
 uploader,err:=tx.UserByID(ctx,uploadedBy)
 if err!=nil&&!errors.Is(err,ports.ErrRowMissing){return domain.LifecyclePolicyView{},err}
 if err!=nil||uploader.DepartmentID==""{return domain.LifecyclePolicyView{},nil}
 departments,err:=tx.ListDepartments(ctx);if err!=nil{return domain.LifecyclePolicyView{},err}
 parent:=map[string]string{}
 for _,d:=range departments{if d.ParentID!=nil{parent[d.ID]=*d.ParentID}}
 visited=map[string]bool{}
 for id:=uploader.DepartmentID;id!=""&&!visited[id];id=parent[id]{
  visited[id]=true
  pol,err:=tx.DepartmentLifecyclePolicy(ctx,id)
  if err==nil{return domain.LifecyclePolicyView{LifecyclePolicy:pol,SourceKind:"department",SourceID:id},nil}
  if !errors.Is(err,ports.ErrRowMissing){return domain.LifecyclePolicyView{},err}
 }
 return domain.LifecyclePolicyView{},nil
}
func(s *Service)LifecyclePolicy(ctx context.Context,u domain.User,kind,id string)(domain.LifecyclePolicyView,error){
 if kind!="folder"&&kind!="department"{return domain.LifecyclePolicyView{},domain.ErrInvalidInput}
 tx,err:=s.uow.Begin(ctx);if err!=nil{return domain.LifecyclePolicyView{},err};defer tx.Rollback(ctx)
 if kind=="folder"{
  folder,err:=s.activeFolder(ctx,tx,id);if err!=nil{return domain.LifecyclePolicyView{},err}
  if err=s.requireListable(ctx,tx,u,id);err!=nil{return domain.LifecyclePolicyView{},err}
  view,err:=s.effectiveLifecyclePolicy(ctx,tx,id,folder.OwnerID)
  view.CanManage=u.IsAdmin;return view,err
 }
 if !u.IsAdmin{return domain.LifecyclePolicyView{},domain.ErrForbidden}
 deps,err:=tx.ListDepartments(ctx);if err!=nil{return domain.LifecyclePolicyView{},err}
 exists:=false;for _,d:=range deps{if d.ID==id{exists=true;break}}
 if !exists{return domain.LifecyclePolicyView{},domain.ErrNotFound}
 byID:=map[string]*string{};for _,d:=range deps{byID[d.ID]=d.ParentID}
 visited:=map[string]bool{}
 for current:=id;current!=""&&!visited[current];{
  visited[current]=true
  pol,e:=tx.DepartmentLifecyclePolicy(ctx,current)
  if e==nil{return domain.LifecyclePolicyView{LifecyclePolicy:pol,SourceKind:"department",SourceID:current,CanManage:true},nil}
  if !errors.Is(e,ports.ErrRowMissing){return domain.LifecyclePolicyView{},e}
  if byID[current]==nil{break};current=*byID[current]
 }
 return domain.LifecyclePolicyView{CanManage:true},nil
}
func(s *Service)SetLifecyclePolicy(ctx context.Context,u domain.User,kind,id string,pol *domain.LifecyclePolicy)error{
 if !u.IsAdmin{return domain.ErrForbidden}
 if kind!="folder"&&kind!="department"{return domain.ErrInvalidInput}
 if pol!=nil&&!validLifecyclePolicy(*pol){return domain.ErrInvalidInput}
 tx,err:=s.uow.Begin(ctx);if err!=nil{return err};defer tx.Rollback(ctx)
 if kind=="folder"{
  if _,err=s.activeFolder(ctx,tx,id);err!=nil{return err}
  if pol==nil{err=tx.DeleteFolderLifecyclePolicy(ctx,id)}else{err=tx.PutFolderLifecyclePolicy(ctx,id,*pol,u.ID)}
 }else{
  deps,e:=tx.ListDepartments(ctx);if e!=nil{return e}
  found:=false;for _,d:=range deps{if d.ID==id{found=true;break}}
  if !found{return domain.ErrNotFound}
  if pol==nil{err=tx.DeleteDepartmentLifecyclePolicy(ctx,id)}else{err=tx.PutDepartmentLifecyclePolicy(ctx,id,*pol,u.ID)}
 }
 if err!=nil{return err}
 action:="lifecycle.policy.upsert";if pol==nil{action="lifecycle.policy.clear"}
 if err=auditRequired(ctx,tx,u,action,kind,id,"success",map[string]any{"policy":pol});err!=nil{return err}
 if err=tx.Commit(ctx);err!=nil{return err}
 s.notifyWorkspaceChange("lifecycle")
 return nil
}
