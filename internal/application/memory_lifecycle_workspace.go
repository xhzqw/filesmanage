package application

import(
 "context"
 "filesmanage/internal/domain"
 "sort"
 "time"
)
func(r *memoryRepo)ListLifecycleLedger(_ context.Context,after,state string,limit int,now time.Time)([]domain.LifecycleLedgerRow,error){
 r.mu.Lock();defer r.mu.Unlock()
 ids:=make([]string,0,len(r.lifecycle));for id:=range r.lifecycle{ids=append(ids,id)};sort.Strings(ids)
 out:=make([]domain.LifecycleLedgerRow,0)
 for _,id:=range ids{
  l:=r.lifecycle[id];f,ok:=r.files[id]
  if !ok||f.DeletedAt!=nil||id<=after||(state!=""&&l.State!=state){continue}
  out=append(out,domain.LifecycleLedgerRow{FileID:id,FileName:f.Name,FolderID:f.FolderID,State:l.State,PublishedSeq:l.PublishedSeq,DueAt:l.DueAt,RetentionUntil:l.RetentionUntil})
  if len(out)>=limit{break}
 }
 return out,nil
}
func(r *memoryRepo)ListLifecycleNotifications(_ context.Context,userID string)([]domain.LifecycleNotification,error){
 r.mu.Lock();defer r.mu.Unlock()
 out:=make([]domain.LifecycleNotification,0)
 for _,n:=range r.lifecycleNotifications{
  life,found:=r.lifecycle[n.FileID];f,exists:=r.files[n.FileID]
  if !found||!exists||f.DeletedAt!=nil||life.PublishedBy!=userID||life.DueAt==nil||!life.DueAt.Equal(n.DueAt){continue}
  n.FileName=f.Name;out=append(out,n)
 }
 sort.Slice(out,func(i,j int)bool{return out[i].ID>out[j].ID})
 if len(out)>100{out=out[:100]}
 return out,nil
}
func(r *memoryRepo)ReadLifecycleNotification(_ context.Context,userID string,id int64)(bool,error){
 r.mu.Lock();defer r.mu.Unlock()
 for i:=range r.lifecycleNotifications{n:=&r.lifecycleNotifications[i];life,ok:=r.lifecycle[n.FileID];if n.ID==id&&ok&&life.PublishedBy==userID{n.Read=true;return true,nil}}
 return false,nil
}
func(r *memoryRepo)HasProtectedLifecycleInFolders(_ context.Context,folders []string,now time.Time)(bool,error){
 r.mu.Lock();defer r.mu.Unlock()
 selected:=map[string]bool{};for _,f:=range folders{selected[f]=true}
 for id,l:=range r.lifecycle{
  file,ok:=r.files[id]
  if ok&&file.DeletedAt==nil&&selected[file.FolderID]&&(l.State=="archived"||(l.RetentionUntil!=nil&&l.RetentionUntil.After(now))){return true,nil}
 }
 return false,nil
}
