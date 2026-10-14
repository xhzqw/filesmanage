package application
import("context";"filesmanage/internal/domain";"time")
func(r *memoryRepo)LifecycleStatistics(_ context.Context,now time.Time)(domain.LifecycleStatistics,error){
 r.mu.Lock();defer r.mu.Unlock()
 var v domain.LifecycleStatistics
 for id,l:=range r.lifecycle{
  f,ok:=r.files[id];if !ok||f.DeletedAt!=nil{continue}
  if l.State=="archived"{v.Archived++}else{v.Released++}
  if l.DueAt!=nil{
   if !l.DueAt.After(now){v.Overdue++}else if !l.DueAt.After(now.Add(30*24*time.Hour)){v.DueSoon++}
  }
  if l.RetentionUntil!=nil&&l.RetentionUntil.After(now){v.Retained++}
 }
 return v,nil
}
